/**
 * Cloudflare Pages Function: /api/picks — the author's-picks write path (ADR-0033).
 *
 *   GET        read the stored document and its ETag (for the editor)
 *   PUT | POST replace it, with an If-Match ETag and an append-only history object
 *   anything else -> 405
 *
 * This is the only route in the project that can write to the catalogue bucket,
 * so it is built to be attacked:
 *
 *   1. **Authorisation is the Access JWT and nothing else.** It is verified here
 *      (`_lib/accessJwt.ts`), not assumed from the presence of a header or from
 *      the fact that the request reached this path. Neither the URL, the `Origin`
 *      header, nor any other client-settable value takes part in the decision.
 *   2. **Fail closed.** No Access configuration, unreadable signing keys, or an
 *      unreachable iptv-org list all end the request before a byte is written.
 *   3. **No credential lives here.** The write capability is an R2 *binding*
 *      (`CATALOGUE_BUCKET`), scoped to `streamloom-catalogue` alone. There is no
 *      API token, no Supabase key and no Upstash token in this project, and
 *      nothing here is a `VITE_` variable, so nothing reaches the bundle.
 *      The binding is typed `get`/`head`/`put` only: there is deliberately no
 *      `delete`, so no future edit can retire an object from this route
 *      (backend CLAUDE.md, "retire by flag, never delete").
 *   4. **Nothing is overwritten by accident.** `picks.json` is written only when
 *      the caller's `If-Match` still names the live copy, and the conditional put
 *      re-checks it at the store. History objects are never overwritten at all.
 *   5. **No CORS headers are emitted.** The portal is same-origin. A cross-origin
 *      page therefore cannot read a response, its preflight is refused (405 on
 *      OPTIONS), and the JSON content type it would need for a write is one a
 *      form post cannot produce without that preflight.
 */

import { authoriseAccessRequest, type AccessFailure } from '../_lib/accessJwt'
import { judgeChannel, loadIptvIndex } from '../_lib/iptvOrg'
import {
  historyKeySegment,
  LIMITS,
  PICKS_SCHEMA,
  pinnedIds,
  validatePicksInput,
  type PicksDocument,
} from '../_lib/picksSchema'

/** The one object clients read (ADR-0030: generation-independent, outside `catalogue/g<N>/`). */
const PICKS_KEY = 'catalogue/picks.json'
const HISTORY_PREFIX = 'picks-history/'

/** Matches ADR-0033 §7: a published pick appears within the object's short cache lifetime. */
const PICKS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

/** If a history key is somehow taken, try this many suffixes before giving up. Never overwrite. */
const HISTORY_SUFFIX_TRIES = 5

interface R2Object {
  httpEtag: string
  size?: number
  json: <T>() => Promise<T>
  text: () => Promise<string>
}

/**
 * Read-and-append surface of the catalogue bucket. There is deliberately no
 * `delete`: the binding cannot retire anything from this route.
 */
interface CatalogueBucket {
  get: (key: string) => Promise<R2Object | null>
  head: (key: string) => Promise<{ key: string } | null>
  put: (
    key: string,
    value: string,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string }
      onlyIf?: { etagMatches?: string }
    },
  ) => Promise<{ httpEtag: string } | null>
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The editor must never be served a stale document, and no cache anywhere
      // should hold a copy of an authenticated response.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })

/**
 * Turns an authorisation failure into a response.
 *
 * The reason tag is returned because it names no secret and makes a
 * misconfiguration diagnosable without a log; the 503 cases say what is missing
 * so the owner can fix them in a minute.
 */
function refuse(failure: AccessFailure): Response {
  const detail =
    failure.reason === 'access-not-configured'
      ? 'Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD on the Pages project. Until then this route writes nothing.'
      : failure.reason === 'jwks-unavailable'
        ? 'The Access signing keys could not be read, so this request cannot be authorised.'
        : undefined
  return json({ error: 'unauthorised', reason: failure.reason, detail }, failure.status)
}

/** `W/"abc"` and `"abc"` name the same object; compare them the same way. */
const stripWeak = (etag: string): string => etag.replace(/^W\//, '').trim()

function readBucket(env: unknown): CatalogueBucket | null {
  const bucket = (env as { CATALOGUE_BUCKET?: unknown } | undefined)?.CATALOGUE_BUCKET
  return bucket ? (bucket as CatalogueBucket) : null
}

/** The stored document, or null when the object is absent or unreadable. */
async function readStored(object: R2Object): Promise<PicksDocument | null> {
  try {
    const value = (await object.json()) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as PicksDocument
  } catch {
    return null
  }
}

async function handleGet(bucket: CatalogueBucket): Promise<Response> {
  const object = await bucket.get(PICKS_KEY)
  if (!object) {
    // Not an error: nothing has been published yet. The editor starts empty.
    return json({ picks: null, etag: null, limits: LIMITS, schema: PICKS_SCHEMA }, 200)
  }
  const picks = await readStored(object)
  return json(
    { picks, etag: object.httpEtag, limits: LIMITS, schema: PICKS_SCHEMA },
    200,
    { ETag: object.httpEtag },
  )
}

/** 412 with the copy the caller has not seen, so the editor can show it and merge. */
async function conflict(bucket: CatalogueBucket, message: string): Promise<Response> {
  const current = await bucket.get(PICKS_KEY)
  return json(
    {
      error: 'conflict',
      detail: message,
      etag: current?.httpEtag ?? null,
      picks: current ? await readStored(current) : null,
    },
    412,
  )
}

async function handleWrite(request: Request, bucket: CatalogueBucket): Promise<Response> {
  // A cross-origin page cannot send this content type without a preflight, and the
  // preflight is refused. This is a CSRF defence, not authorisation: the JWT above
  // is what decides whether the caller may write.
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return json({ error: 'unsupported-media-type', detail: 'Content-Type must be application/json' }, 415)
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return json({ error: 'cross-site-write-refused' }, 403)
  }

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > LIMITS.bodyBytes) {
    return json({ error: 'too-large', detail: `body must be at most ${LIMITS.bodyBytes} bytes` }, 413)
  }

  const text = await request.text()
  // Re-checked after reading: `content-length` may be absent on a chunked body.
  if (new TextEncoder().encode(text).byteLength > LIMITS.bodyBytes) {
    return json({ error: 'too-large', detail: `body must be at most ${LIMITS.bodyBytes} bytes` }, 413)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'invalid-json' }, 400)
  }

  const validated = validatePicksInput(parsed)
  if (!validated.ok) return json({ error: 'invalid-picks', errors: validated.errors }, 400)

  // Every id is checked against the public list. If the list cannot be read the
  // save is refused: accepting it would be the one way a blocklisted or NSFW id
  // could reach picks.json (ADR-0033 §4).
  const index = await loadIptvIndex()
  if (!index) {
    return json(
      {
        error: 'validation-unavailable',
        detail: 'The iptv-org channel list could not be read, so no id could be checked. Nothing was written.',
      },
      503,
    )
  }

  const refusals: string[] = []
  const warnings: string[] = []
  for (const channelId of pinnedIds(validated.value)) {
    const verdict = judgeChannel(index, channelId)
    if (verdict.verdict === 'refuse') refusals.push(verdict.reason)
    else if (verdict.verdict === 'warn') warnings.push(verdict.warning)
  }
  if (refusals.length > 0) return json({ error: 'invalid-channels', errors: refusals }, 400)

  // `updatedAt` is the server's, never the client's: it is the history key, and a
  // client that could choose it could rewrite the past.
  const updatedAt = new Date().toISOString()
  const document: PicksDocument = {
    schema: PICKS_SCHEMA,
    updatedAt,
    groups: validated.value.groups,
  }
  const body = JSON.stringify(document)

  const current = await bucket.get(PICKS_KEY)
  const ifMatchRaw = request.headers.get('if-match')
  const ifMatch = ifMatchRaw === null ? null : stripWeak(ifMatchRaw)

  if (current) {
    if (ifMatch === null) {
      return conflict(bucket, 'picks.json already exists; send If-Match with the ETag you read.')
    }
    if (ifMatch !== '*' && ifMatch !== stripWeak(current.httpEtag)) {
      return conflict(bucket, 'picks.json changed since you read it.')
    }
  } else if (ifMatch !== null && ifMatch !== '*') {
    return conflict(bucket, 'picks.json does not exist, but If-Match named a copy of it.')
  }

  const written = await bucket.put(PICKS_KEY, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: PICKS_CACHE_CONTROL },
    // Re-checks the precondition at the store, closing the window between the read
    // above and this write. A first write has no ETag to match on; two simultaneous
    // first saves are the one race this cannot close, and both are kept in history.
    ...(current ? { onlyIf: { etagMatches: stripWeak(current.httpEtag) } } : {}),
  })
  if (!written) return conflict(bucket, 'picks.json changed while it was being written.')

  // Append-only (ADR-0033 §6). Written after the live object so history never
  // records a save that did not happen; a history failure does not undo the save,
  // it is reported instead.
  const historyKey = await writeHistory(bucket, updatedAt, body)

  return json(
    {
      ok: true,
      updatedAt,
      etag: written.httpEtag,
      warnings,
      historyKey,
      counts: {
        groups: document.groups.length,
        items: document.groups.reduce((n, g) => n + g.items.length, 0),
      },
    },
    200,
    { ETag: written.httpEtag },
  )
}

/**
 * Writes `picks-history/<updatedAt>.json` without ever overwriting.
 *
 * Returns the key written, or null if every candidate was taken or the store
 * refused. Nothing is deleted and nothing is replaced under any outcome.
 */
async function writeHistory(
  bucket: CatalogueBucket,
  updatedAt: string,
  body: string,
): Promise<string | null> {
  const base = HISTORY_PREFIX + historyKeySegment(updatedAt)
  for (let attempt = 0; attempt < HISTORY_SUFFIX_TRIES; attempt += 1) {
    const key = attempt === 0 ? `${base}.json` : `${base}-${attempt + 1}.json`
    try {
      if (await bucket.head(key)) continue
      await bucket.put(key, body, {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      })
      return key
    } catch {
      return null
    }
  }
  return null
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context

  // Authorisation first, before the method, the body or anything else is looked
  // at: an unauthenticated request learns nothing about this route.
  const auth = await authoriseAccessRequest(request, env)
  if (!auth.ok) return refuse(auth)

  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'PUT' && method !== 'POST') {
    return json({ error: 'method-not-allowed' }, 405, { Allow: 'GET, PUT, POST' })
  }

  const bucket = readBucket(env)
  if (!bucket) {
    return json(
      {
        error: 'storage-not-configured',
        detail:
          'Bind the streamloom-catalogue R2 bucket as CATALOGUE_BUCKET on the Pages project. Nothing was written.',
      },
      503,
    )
  }

  if (method === 'GET') return handleGet(bucket)
  return handleWrite(request, bucket)
}
