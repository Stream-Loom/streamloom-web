/**
 * IndexedDB persistence for the catalogue.
 *
 * localStorage could not hold this: the catalogue is several MB and the old
 * sl_catalogue_v5 write blew the ~5 MB quota, where the QuotaExceededError was
 * swallowed. Nothing was ever persisted, so every visit re-fetched everything.
 * IndexedDB has no such ceiling. Enriched channels are stored as-is, so a repeat
 * visit needs no Redis round-trip and no re-enrichment at all.
 *
 * Per-channel schedules live in a second object store of the same database, keyed
 * by generation and channel id, so a reload does not re-read them from Redis.
 */

import type { Category, EnrichedChannel, EpgProgram } from '../api/types'

const DB_NAME = 'streamloom'
const DB_VERSION = 2
const STORE = 'catalogue'
const SCHEDULE_STORE = 'schedules'
const RECORD_KEY = 'current'

/**
 * Ceiling on how long a stored catalogue is trusted.
 *
 * Freshness is decided by the generation, not by age: a generation is immutable,
 * so a stored catalogue whose generation still matches `catalogue:meta` is exactly
 * what Redis would return. The ceiling only bounds how long an old copy is shown
 * when Redis cannot be reached to check.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface StoredCatalogue {
  channels: EnrichedChannel[]
  categories: Category[]
  epgIds: string[]
  /** Generation the catalogue was read from; null for a record written before generations were stored. */
  generation: number | null
  ts: number
}

/** A channel's schedule as read from one generation. */
interface StoredSchedule {
  generation: number
  channelId: string
  programs: EpgProgram[]
  /** Latest programme end, in ms. Once it has passed the schedule has nothing left to show. */
  endsAt: number
}

function scheduleKey(generation: number, channelId: string): string {
  return generation + ':' + channelId
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        if (!db.objectStoreNames.contains(SCHEDULE_STORE)) db.createObjectStore(SCHEDULE_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function readStoredCatalogue(): Promise<StoredCatalogue | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(RECORD_KEY)
      req.onsuccess = () => {
        const value = req.result as StoredCatalogue | undefined
        db.close()
        if (!value) {
          resolve(null)
          return
        }
        if (Date.now() - value.ts > TTL_MS) {
          resolve(null)
          return
        }
        resolve({ ...value, generation: typeof value.generation === 'number' ? value.generation : null })
      }
      req.onerror = () => {
        db.close()
        resolve(null)
      }
    } catch {
      db.close()
      resolve(null)
    }
  })
}

export async function writeStoredCatalogue(
  data: Omit<StoredCatalogue, 'ts' | 'generation'> & { generation: number },
): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ ...data, ts: Date.now() }, RECORD_KEY)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        resolve()
      }
      tx.onabort = () => {
        db.close()
        resolve()
      }
    } catch {
      db.close()
      resolve()
    }
  })
}

/** Drops the stored catalogue and every stored schedule. */
export async function clearStoredCatalogue(): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE, SCHEDULE_STORE], 'readwrite')
      tx.objectStore(STORE).delete(RECORD_KEY)
      tx.objectStore(SCHEDULE_STORE).clear()
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        resolve()
      }
    } catch {
      db.close()
      resolve()
    }
  })
}

// ---- Schedules ----

function latestEnd(programs: EpgProgram[]): number {
  let latest = 0
  for (const p of programs) {
    const end = new Date(p.end_time).getTime()
    if (Number.isFinite(end) && end > latest) latest = end
  }
  return latest
}

/**
 * Stored schedules for `channelIds` in `generation`.
 *
 * A schedule whose programmes have all ended is not returned and is deleted: a
 * read of it could show nothing, and its generation has nothing newer to offer.
 * Channels with no usable entry are simply absent from the result.
 */
export async function readStoredSchedules(
  generation: number,
  channelIds: string[],
): Promise<Map<string, EpgProgram[]>> {
  const found = new Map<string, EpgProgram[]>()
  if (channelIds.length === 0) return found
  const db = await openDb()
  if (!db) return found
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SCHEDULE_STORE, 'readwrite')
      const store = tx.objectStore(SCHEDULE_STORE)
      const now = Date.now()
      for (const id of channelIds) {
        const key = scheduleKey(generation, id)
        const req = store.get(key)
        req.onsuccess = () => {
          const value = req.result as StoredSchedule | undefined
          if (!value) return
          if (value.endsAt > now && value.programs.length > 0) found.set(id, value.programs)
          else store.delete(key)
        }
      }
      tx.oncomplete = () => {
        db.close()
        resolve(found)
      }
      tx.onerror = () => {
        db.close()
        resolve(found)
      }
      tx.onabort = () => {
        db.close()
        resolve(found)
      }
    } catch {
      db.close()
      resolve(found)
    }
  })
}

/**
 * Stores schedules read from `generation`, and drops every schedule kept for any
 * other generation in the same transaction, so a new publish never leaves the old
 * one behind. Empty schedules are not stored: an empty read is indistinguishable
 * from a failed one.
 */
export async function writeStoredSchedules(
  generation: number,
  entries: Iterable<[string, EpgProgram[]]>,
): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SCHEDULE_STORE, 'readwrite')
      const store = tx.objectStore(SCHEDULE_STORE)
      const keep = generation + ':'

      const cursor = store.openKeyCursor()
      cursor.onsuccess = () => {
        const at = cursor.result
        if (!at) return
        if (!String(at.key).startsWith(keep)) store.delete(at.key)
        at.continue()
      }

      for (const [channelId, programs] of entries) {
        const endsAt = latestEnd(programs)
        if (programs.length === 0 || endsAt <= Date.now()) continue
        const record: StoredSchedule = { generation, channelId, programs, endsAt }
        store.put(record, scheduleKey(generation, channelId))
      }

      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        resolve()
      }
      tx.onabort = () => {
        db.close()
        resolve()
      }
    } catch {
      db.close()
      resolve()
    }
  })
}
