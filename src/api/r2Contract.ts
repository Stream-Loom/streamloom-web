/**
 * The R2 snapshot contract (ADR-0030, ADR-0034 in streamloom-backend), with no I/O.
 *
 * Object layout, one directory per generation:
 *   catalogue/meta.json                       { generation, version, layout, counts, ... }
 *   catalogue/g<N>/channels.json.br           Channel[]
 *   catalogue/g<N>/streams.json.br            Stream[]
 *   catalogue/g<N>/categories.json.br         Category[]
 *   catalogue/g<N>/epg/ids.json.br            string[]      (channels with a schedule)
 *   catalogue/g<N>/epg/<channelId>.json.br    EpgProgram[]  (one channel, on demand)
 *
 * Everything here is pure so the golden fixture can be decoded in a plain Node test
 * through the same code the browser runs. The fetching lives in `r2.ts`.
 */

import type { Category, Channel, EpgProgram, Stream } from './types'

/** Shape of the rows; must match CATALOGUE_VERSION in the sync worker and the Redis path. */
export const SUPPORTED_VERSION = 2

/** Naming of the objects; must match R2_LAYOUT_VERSION in the sync worker. */
export const SUPPORTED_LAYOUT = 1

export interface R2Meta {
  generation: number
  version: number
  layout: number
  syncedAt?: string
  hash?: string
  guide?: boolean
  counts: {
    channels: number
    streams: number
    categories: number
    epgChannels: number
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * A meta this client can read, or null.
 *
 * An unknown `version` (row shape) or `layout` (object naming) is refused rather than
 * guessed at, so a newer worker can never make an older client mis-read a generation.
 */
export function parseMeta(raw: unknown): R2Meta | null {
  if (!isRecord(raw)) return null
  if (raw.version !== SUPPORTED_VERSION || raw.layout !== SUPPORTED_LAYOUT) return null
  if (!isCount(raw.generation)) return null
  const counts = raw.counts
  if (!isRecord(counts)) return null
  if (
    !isCount(counts.channels) ||
    !isCount(counts.streams) ||
    !isCount(counts.categories) ||
    !isCount(counts.epgChannels)
  ) {
    return null
  }
  return {
    generation: raw.generation,
    version: raw.version,
    layout: raw.layout,
    syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : undefined,
    hash: typeof raw.hash === 'string' ? raw.hash : undefined,
    guide: typeof raw.guide === 'boolean' ? raw.guide : undefined,
    counts: {
      channels: counts.channels,
      streams: counts.streams,
      categories: counts.categories,
      epgChannels: counts.epgChannels,
    },
  }
}

// ---- Object URLs ----

export function metaUrl(base: string): string {
  return base + '/catalogue/meta.json'
}

export type BulkObject = 'channels' | 'streams' | 'categories'

export function bulkUrl(base: string, generation: number, name: BulkObject): string {
  return base + '/catalogue/g' + generation + '/' + name + '.json.br'
}

export function epgIdsUrl(base: string, generation: number): string {
  return base + '/catalogue/g' + generation + '/epg/ids.json.br'
}

/**
 * True when a channel id can be an object key. Mirrors `r2ChannelSegment` in the
 * worker: a CDN percent-decodes the path before looking the key up, so an id with
 * `%`, `/`, `?` or a space has no URL that reaches what was stored. Such an id
 * keeps its guide in Redis only.
 */
export function isSnapshotChannelId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(id) && id !== 'ids'
}

/** URL of one channel's schedule; null for an id that has no object. */
export function epgUrl(base: string, generation: number, channelId: string): string | null {
  if (!isSnapshotChannelId(channelId)) return null
  return base + '/catalogue/g' + generation + '/epg/' + channelId + '.json.br'
}

// ---- Row decoding ----

function rows<T>(value: unknown, isRow: (row: unknown) => boolean): T[] | null {
  if (!Array.isArray(value)) return null
  for (const row of value) if (!isRow(row)) return null
  return value as T[]
}

const isChannel = (row: unknown): boolean =>
  isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'

const isStream = (row: unknown): boolean => isRecord(row) && typeof row.url === 'string'

const isCategory = (row: unknown): boolean =>
  isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'

const isProgram = (row: unknown): boolean =>
  isRecord(row) &&
  typeof row.title === 'string' &&
  typeof row.start_time === 'string' &&
  typeof row.end_time === 'string'

export const decodeChannels = (value: unknown): Channel[] | null => rows<Channel>(value, isChannel)
export const decodeStreams = (value: unknown): Stream[] | null => rows<Stream>(value, isStream)
export const decodeCategories = (value: unknown): Category[] | null => rows<Category>(value, isCategory)
export const decodeEpg = (value: unknown): EpgProgram[] | null => rows<EpgProgram>(value, isProgram)
export const decodeEpgIds = (value: unknown): string[] | null =>
  rows<string>(value, (row) => typeof row === 'string')

export interface DecodedCatalogue {
  channels: Channel[]
  streams: Stream[]
  categories: Category[]
}

/**
 * The three bulk objects of one generation, checked against the `counts` its meta
 * declares. A count that disagrees means an object is truncated or belongs to a
 * different generation, and the whole load is refused (null) so the caller falls
 * through instead of showing half a catalogue.
 */
export function decodeCatalogue(
  meta: R2Meta,
  raw: { channels: unknown; streams: unknown; categories: unknown },
): DecodedCatalogue | null {
  const channels = decodeChannels(raw.channels)
  const streams = decodeStreams(raw.streams)
  const categories = decodeCategories(raw.categories)
  if (!channels || !streams || !categories) return null
  if (
    channels.length !== meta.counts.channels ||
    streams.length !== meta.counts.streams ||
    categories.length !== meta.counts.categories
  ) {
    return null
  }
  return { channels, streams, categories }
}
