import type { BrowserContext } from '@playwright/test'

/**
 * In-process stand-in for the Upstash REST endpoint.
 *
 * Every real Upstash read is metered, so tests that exist to *count* reads must
 * not spend them. The mock answers `GET /get/<key>` for the ADR-0015 key scheme
 * from a synthetic catalogue and records each request by key kind.
 *
 * Interception is by URL shape (`/get/catalogue%3A...`), not by host, so it works
 * whichever Upstash URL the dev server was started with.
 */

export type KeyKind = 'meta' | 'channels' | 'streams' | 'categories' | 'epgIds' | 'schedule'

export interface RequestLog {
  kind: KeyKind
  key: string
}

export interface MockOptions {
  generation?: number
  /** Channels published with a schedule (and a stream), i.e. rows in the guide. */
  guideChannels?: number
  totalChannels?: number
  pageSize?: number
  /** Publish schedules whose programmes have all ended, as a lagging feed does. */
  endedSchedules?: boolean
}

export interface UpstashMock {
  /** Every `GET` since the last `reset()`. */
  requests: RequestLog[]
  count(kind: KeyKind): number
  /** GETs for catalogue data (everything except `meta` and schedules). */
  catalogueDataCount(): number
  reset(): void
  /** Publishes a new generation, as the sync worker does. */
  setGeneration(generation: number): void
}

const ROUTE = /\/get\/catalogue%3A/

function classify(key: string): KeyKind | null {
  if (key === 'catalogue:meta') return 'meta'
  if (/:channels:page:\d+$/.test(key)) return 'channels'
  if (/:streams:page:\d+$/.test(key)) return 'streams'
  if (/:categories$/.test(key)) return 'categories'
  if (/:epg:ids$/.test(key)) return 'epgIds'
  if (/:epg:[^:]+$/.test(key)) return 'schedule'
  return null
}

function scheduleFor(channelId: string, ended: boolean): unknown[] {
  // One-hour programmes from four hours ago to twenty hours ahead, so the guide
  // shows a live "now" and the schedule stays unexpired for the whole test. An
  // ended schedule runs from thirty hours ago to six hours ago instead.
  const hour = 3_600_000
  const base = Math.floor((Date.now() - (ended ? 30 : 4) * hour) / hour) * hour
  return Array.from({ length: 24 }, (_, i) => ({
    id: `${channelId}:${i}`,
    channel_id: channelId,
    title: `Show ${i}`,
    description: null,
    start_time: new Date(base + i * hour).toISOString(),
    end_time: new Date(base + (i + 1) * hour).toISOString(),
  }))
}

export async function installUpstashMock(
  context: BrowserContext,
  options: MockOptions = {},
): Promise<UpstashMock> {
  const guideChannels = options.guideChannels ?? 526
  const totalChannels = options.totalChannels ?? 600
  const pageSize = options.pageSize ?? 100
  let generation = options.generation ?? 1_790_000_000_000

  const channels = Array.from({ length: totalChannels }, (_, i) => ({
    id: `ch${i}.xx`,
    name: `Channel ${i}`,
    logo: null,
    country: 'US',
    is_active: true,
    channel_categories: [{ category_id: 'news' }],
    languages: ['eng'],
  }))
  // Every second channel has a backup candidate: 900 streams, which at 100 a page
  // gives the nine stream pages production publishes today.
  const streams = channels.flatMap((c, i) =>
    Array.from({ length: i % 2 === 0 ? 2 : 1 }, (_, n) => ({
      channel_id: c.id,
      url: `https://streams.invalid/${c.id}-${n}.m3u8`,
      quality: n === 0 ? '1080p' : '720p',
      status: 'working',
    })),
  )
  const epgIds = channels.slice(0, guideChannels).map((c) => c.id)
  const pages = <T>(rows: T[]) =>
    Array.from({ length: Math.ceil(rows.length / pageSize) }, (_, i) =>
      rows.slice(i * pageSize, (i + 1) * pageSize),
    )
  const channelPages = pages(channels)
  const streamPages = pages(streams)

  const mock: UpstashMock = {
    requests: [],
    count: (kind) => mock.requests.filter((r) => r.kind === kind).length,
    catalogueDataCount: () =>
      mock.requests.filter((r) => r.kind !== 'meta' && r.kind !== 'schedule').length,
    reset: () => { mock.requests.length = 0 },
    setGeneration: (g) => { generation = g },
  }

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
  }

  await context.route(ROUTE, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors })
      return
    }

    const key = decodeURIComponent(new URL(request.url()).pathname.replace(/^.*\/get\//, ''))
    const kind = classify(key)
    if (!kind) {
      await route.fulfill({ status: 200, headers: cors, json: { result: null } })
      return
    }
    mock.requests.push({ kind, key })

    // Keys of an old generation stay readable, as they do in Redis until they expire.
    let value: unknown = null
    if (kind === 'meta') {
      value = {
        generation,
        version: 2,
        pages: { channels: channelPages.length, streams: streamPages.length },
        syncedAt: new Date().toISOString(),
      }
    } else if (kind === 'channels') {
      value = channelPages[Number(key.split(':').pop())] ?? null
    } else if (kind === 'streams') {
      value = streamPages[Number(key.split(':').pop())] ?? null
    } else if (kind === 'categories') {
      value = [{ id: 'news', name: 'News' }]
    } else if (kind === 'epgIds') {
      value = epgIds
    } else {
      value = scheduleFor(key.split(':epg:')[1], options.endedSchedules ?? false)
    }

    await route.fulfill({
      status: 200,
      headers: cors,
      json: { result: value === null ? null : JSON.stringify(value) },
    })
  })

  return mock
}
