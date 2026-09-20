/**
 * Catalogue worker.
 *
 * Fetches the catalogue from Redis, parses the page payloads and joins channels
 * with their streams off the main thread. Parsing several MB of JSON and walking
 * ~40k rows was the largest main-thread cost on a cold load, so it happens here
 * and only the finished arrays are handed back.
 */

import { fetchCatalogueFromRedis, fetchEpgIdsFromRedis } from '../api/redis'
import { enrichChannels } from '../util/enrich'
import type { WorkingRecord } from '../util/enrich'
import { buildSearchIndex, type SearchIndex } from '../util/searchText'
import type { Category, EnrichedChannel } from '../api/types'

export interface CatalogueWorkerRequest {
  working: Record<string, WorkingRecord>
}

export interface CatalogueWorkerResponse {
  ok: boolean
  channels: EnrichedChannel[]
  categories: Category[]
  /** Null when the schedule index could not be read. */
  epgIds: string[] | null
  searchIndex?: SearchIndex
  error?: string
}

// Typed via a narrow local shape so this file needs no webworker lib reference.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<CatalogueWorkerRequest>) => void) | null
  postMessage: (message: CatalogueWorkerResponse) => void
}

ctx.onmessage = async (event: MessageEvent<CatalogueWorkerRequest>) => {
  const working = event.data.working ?? {}

  try {
    const catalogue = await fetchCatalogueFromRedis()

    if (!catalogue) {
      ctx.postMessage({
        ok: false,
        channels: [],
        categories: [],
        epgIds: null,
        error: 'Catalogue is not available',
      })
      return
    }

    const epgIds = await fetchEpgIdsFromRedis()
    const channels = enrichChannels(catalogue.channels, catalogue.streams, working)
    const searchIndex = buildSearchIndex(channels)

    ctx.postMessage({
      ok: true,
      channels,
      categories: catalogue.categories,
      epgIds,
      searchIndex,
    })
  } catch (e) {
    ctx.postMessage({
      ok: false,
      channels: [],
      categories: [],
      epgIds: null,
      error: (e as Error).message,
    })
  }
}
