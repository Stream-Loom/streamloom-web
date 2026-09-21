/**
 * Cloudflare Pages Function: /api/streams/known/:channelId
 *
 * Returns the global stream-verification record for a channel, if one exists.
 *
 * The record lives in the `channel-icons` R2 bucket (`stream-verify/<id>.json`).
 * No public route writes it: `/api/streams` used to publish here from
 * query-string input, which let any caller overwrite what every visitor reads.
 * It needs a trusted writer (the backend probe, holding R2 credentials); until
 * one exists this returns 404 and the client falls back to a live probe. Reads
 * are consistent across POPs because R2 is geo-replicated, and the client
 * re-validates past `ttlMs`.
 *
 * Routes:
 *   GET /api/streams/known/:channelId  -> verified record, or 404
 *
 * Response shape matches `EdgeStreamsPayload` from `/api/streams/index.ts`
 * (minus the `edgeNode` field, since the record is global).
 */

interface KnownStreamPayload {
  channelId: string
  workingStream: string | null
  workingCandidates: string[]
  deadCandidates: string[]
  verifiedAt: number
  /** TTL in milliseconds; clients should re-probe past this age. */
  ttlMs: number
}

/** Channel ids become path segments, so only safe characters are accepted. */
function normalizeChannelId(raw: string | undefined): string | null {
  if (!raw) return null
  let id: string
  try {
    id = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return null
  return id
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'public, max-age=60',
  }
}

export const onRequest: PagesFunction = async (context) => {
  const { request, params } = context
  const urlObj = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  const rawParam = Array.isArray(params.channelId) ? params.channelId[0] : params.channelId
  const channelId = normalizeChannelId(rawParam ?? urlObj.searchParams.get('channelId') ?? undefined)
  if (!channelId) {
    return new Response('Invalid channel id', { status: 400, headers: corsHeaders() })
  }

  // Binding is optional so the site still serves if it is unset.
  // @ts-ignore -- ICONS_BUCKET is provided by the Pages binding
  const bucket = (context.env as { ICONS_BUCKET?: unknown } | undefined)?.ICONS_BUCKET as
    | { get: (k: string) => Promise<{ body: ReadableStream; size?: number; uploaded: Date; httpEtag?: string; httpMetadata?: { contentType?: string } } | null>; head: (k: string) => Promise<unknown> }
    | undefined
  if (!bucket) {
    return new Response('Stream verification store is not configured', { status: 503, headers: corsHeaders() })
  }

  const key = `stream-verify/${channelId}.json`

  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = await bucket.get(key)
    if (!object) {
      return new Response('Not found', { status: 404, headers: corsHeaders() })
    }

    // Cheap freshness check via the If-Modified-Since header so a swarm of
    // clients re-fetching the same channel does not re-download the body.
    const ifModifiedSince = request.headers.get('If-Modified-Since')
    if (ifModifiedSince) {
      const since = Date.parse(ifModifiedSince)
      if (!Number.isNaN(since) && object.uploaded.getTime() <= since) {
        return new Response(null, { status: 304, headers: corsHeaders() })
      }
    }

    const headers = new Headers(corsHeaders())
    headers.set('Content-Type', 'application/json; charset=utf-8')
    headers.set('Last-Modified', object.uploaded.toUTCString())
    if (object.size) headers.set('Content-Length', String(object.size))

    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders() })
}

// Exported for `index.ts` so the write side uses the same shape.
export type { KnownStreamPayload }
