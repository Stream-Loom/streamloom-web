/**
 * R2 snapshot client — read-only, plain HTTPS GETs (ADR-0030).
 *
 * The catalogue is published as immutable brotli objects behind a public CDN
 * hostname, so a read costs nothing per request and an unchanged generation costs
 * one small `meta.json` fetch. The browser decodes `Content-Encoding: br` itself,
 * so `res.json()` yields the rows directly.
 *
 * Every function resolves to null on any miss, malformed object or timeout so the
 * caller (catalogueSource.ts) can fall through to Redis. Nothing here throws.
 *
 * Requests carry no custom headers, so they are CORS "simple" requests and never
 * preflight; the bucket's CORS rule only has to allow the site's origin for GET.
 */

import type { EpgProgram } from './types'
import {
  bulkUrl,
  decodeCatalogue,
  decodeEpg,
  decodeEpgIds,
  epgIdsUrl,
  epgUrl,
  metaUrl,
  parseMeta,
} from './r2Contract'
import type { DecodedCatalogue, R2Meta } from './r2Contract'

/** The CDN hostname the snapshot is served from. A build-time setting; never hard-coded. */
const BASE_URL = (
  ((import.meta.env.VITE_CATALOGUE_R2_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
)

/** True when a snapshot base URL is configured (the build refuses to ship without one). */
export const isR2Configured = /^https?:\/\//i.test(BASE_URL)

/** Ceiling on one object's transfer size; the real ones are a few hundred KB brotli. */
const MAX_BYTES = 8 * 1024 * 1024

/** Budgets before giving up on R2 and falling through to Redis. */
export const R2_META_BUDGET_MS = 5_000
export const R2_CATALOGUE_BUDGET_MS = 8_000
export const R2_EPG_BUDGET_MS = 6_000

/**
 * After a transport failure R2 is skipped for this long, so a dead CDN costs one
 * timeout rather than one per request (a screenful of guide rows would otherwise
 * each wait out its own).
 */
const COOLDOWN_MS = 30_000
let downUntil = 0

const available = () => isR2Configured && Date.now() >= downUntil
const markDown = () => { downUntil = Date.now() + COOLDOWN_MS }

/** Test seam: forgets a recorded failure. */
export function resetR2Cooldown() { downUntil = 0 }

/**
 * GETs and JSON-decodes one object; null on any failure.
 *
 * A 4xx is a definite "not there" and does not mark R2 down; a network error,
 * timeout, 5xx or undecodable body does.
 */
async function getJson(url: string, ctl: AbortController): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) {
      if (res.status >= 500) markDown()
      return null
    }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null
    return await res.json()
  } catch {
    markDown()
    return null
  }
}

/** Runs `fn` with an AbortController that fires after `ms`. */
async function withBudget<T>(ms: number, fn: (ctl: AbortController) => Promise<T | null>): Promise<T | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fn(ctl)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `catalogue/meta.json`: which generation is live. One small GET. */
export async function fetchR2Meta(): Promise<R2Meta | null> {
  if (!available()) return null
  return withBudget(R2_META_BUDGET_MS, async (ctl) => parseMeta(await getJson(metaUrl(BASE_URL), ctl)))
}

/**
 * The bulk objects of the generation `meta` names (three requests, in parallel).
 *
 * Every URL is built from `meta.generation`, so the objects cannot come from two
 * generations. The first failure aborts the others.
 */
export async function fetchCatalogueFromR2(meta: R2Meta): Promise<DecodedCatalogue | null> {
  if (!available()) return null
  return withBudget(R2_CATALOGUE_BUDGET_MS, async (ctl) => {
    const get = async (name: 'channels' | 'streams' | 'categories') => {
      const value = await getJson(bulkUrl(BASE_URL, meta.generation, name), ctl)
      if (value === null) ctl.abort()
      return value
    }
    const [channels, streams, categories] = await Promise.all([
      get('channels'),
      get('streams'),
      get('categories'),
    ])
    return decodeCatalogue(meta, { channels, streams, categories })
  })
}

/** Channel ids that have a schedule in `generation`; null when unreadable. */
export async function fetchEpgIdsFromR2(generation: number): Promise<string[] | null> {
  if (!available()) return null
  return withBudget(R2_EPG_BUDGET_MS, async (ctl) => decodeEpgIds(await getJson(epgIdsUrl(BASE_URL, generation), ctl)))
}

/**
 * One channel's schedule from `generation`. Null (not an empty list) when it could
 * not be read, so the caller can tell "no such object" from "nothing scheduled".
 */
export async function fetchEpgFromR2(channelId: string, generation: number): Promise<EpgProgram[] | null> {
  if (!available()) return null
  const url = epgUrl(BASE_URL, generation, channelId)
  if (!url) return null
  return withBudget(R2_EPG_BUDGET_MS, async (ctl) => decodeEpg(await getJson(url, ctl)))
}
