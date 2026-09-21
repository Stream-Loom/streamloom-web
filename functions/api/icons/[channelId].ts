/**
 * Cloudflare Pages Function: /api/icons/:channelId
 *
 * Read-only view of the `channel-icons` R2 bucket. The bracketed filename maps
 * the sub-path to `params.channelId`.
 *
 * Routes:
 *   GET|HEAD /api/icons/:channelId  -> serve the stored icon, or 404
 *   anything else                   -> 405
 *
 * This route never writes. It used to accept `POST { url }`, fetch that URL from
 * the edge and store the bytes, with no authorisation and a wildcard CORS policy:
 * anyone could plant an icon under any channel id (first write wins, cached for a
 * year) and use the edge as a fetcher. Icons are written only by the backend icon
 * pipeline (ADR-0019), which holds its own R2 credentials, so a public route has
 * nothing to authenticate and must not hold a write path. The bucket binding is
 * typed `get`/`head` only, so a write cannot be added here without changing it.
 */

/** Object key inside the bucket for a channel. */
function iconKey(channelId: string): string {
  return `icons/${channelId}.webp`
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
    'Access-Control-Max-Age': '86400',
  }
}

interface IconObject {
  body: ReadableStream
  size?: number
  httpEtag: string
  httpMetadata?: { contentType?: string }
}

/** Read-only surface of the R2 binding; there is deliberately no `put`. */
interface IconReader {
  get: (key: string) => Promise<IconObject | null>
}

export const onRequest: PagesFunction = async (context) => {
  const { request, params } = context
  const urlObj = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...corsHeaders(), Allow: 'GET, HEAD, OPTIONS' },
    })
  }

  // The route is /api/icons/:channelId; the wildcard also tolerates the id
  // arriving as a trailing query value during local development.
  const rawParam = Array.isArray(params.channelId) ? params.channelId[0] : params.channelId
  const channelId = normalizeChannelId(rawParam ?? urlObj.searchParams.get('channelId') ?? undefined)

  if (!channelId) {
    return new Response('Invalid channel id', { status: 400, headers: corsHeaders() })
  }

  // Binding is optional so the site still serves if it is unset.
  // @ts-ignore -- ICONS_BUCKET is provided by the Pages binding
  const bucket = (context.env as { ICONS_BUCKET?: unknown } | undefined)?.ICONS_BUCKET as
    | IconReader
    | undefined
  if (!bucket) {
    return new Response('Icon storage is not configured', { status: 503, headers: corsHeaders() })
  }

  const object = await bucket.get(iconKey(channelId))
  if (!object) {
    return new Response('Not found', { status: 404, headers: corsHeaders() })
  }

  const headers = new Headers(corsHeaders())
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', object.httpEtag)
  // Stored bytes are treated as opaque data: an SVG that was put here before the
  // write path was removed must not run script if it is opened directly.
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  if (object.size) headers.set('Content-Length', String(object.size))

  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
}
