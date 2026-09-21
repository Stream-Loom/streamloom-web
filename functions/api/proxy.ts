/**
 * Cloudflare Pages Function: /api/proxy
 * 
 * High-performance edge streaming proxy with:
 * - Multi-candidate server-side fallback: automatically fails over to alternate candidates
 *   without requiring multiple client-side round trips.
 * - Edge POP caching: prioritizes pre-verified working streams from caches.default.
 * - Dynamic M3U8 manifest rewriting for CORS bypass and mixed-content resolution.
 * - Content-length and content-encoding stripping to prevent body truncation.
 */

function updateEdgeCacheWorkingStream(channelId: string, workingUrl: string, colo: string, context: any) {
  if (!channelId || channelId === 'unknown') return
  const cacheKey = `https://streamloom.internal/edge-streams/${encodeURIComponent(channelId)}`
  const updateJob = async () => {
    try {
      // @ts-ignore
      if (typeof caches === 'undefined' || !caches.default) return
      // @ts-ignore
      const edgeCache = caches.default
      let existingData: any = null
      try {
        const match = await edgeCache.match(cacheKey)
        if (match) {
          existingData = await match.json()
        }
      } catch {}

      const workingCandidates = Array.from(new Set([workingUrl, ...(existingData?.workingCandidates || [])]))
      const deadCandidates = (existingData?.deadCandidates || []).filter((u: string) => u !== workingUrl)

      const payload = {
        channelId,
        workingStream: workingUrl,
        workingCandidates,
        deadCandidates,
        edgeNode: colo,
        timestamp: Date.now(),
      }

      const cacheResponse = new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=7200',
          'Access-Control-Allow-Origin': '*',
        },
      })
      await edgeCache.put(cacheKey, cacheResponse)
    } catch {
      // Ignore edge cache write errors
    }
  }

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(updateJob())
  } else {
    updateJob().catch(() => {})
  }
}

export const onRequest: PagesFunction = async (context) => {
  const { request } = context
  const urlObj = new URL(request.url)
  const targetUrl = urlObj.searchParams.get('url')

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  if (!targetUrl) {
    return new Response('Missing target url query parameter', {
      status: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    })
  }

  const channelId = urlObj.searchParams.get('channelId') || ''
  const rawFallbacks = urlObj.searchParams.getAll('fallback')
    .flatMap((f) => f.split(','))
    .map((f) => f.trim())
    .filter(Boolean)

  const cfColo = (request as any).cf?.colo || 'UNKNOWN'

  // Candidate URLs list
  let candidateUrls = Array.from(new Set([targetUrl, ...rawFallbacks]))

  // Check if edge cache already verified a working stream for this channel
  if (channelId) {
    try {
      // @ts-ignore
      if (typeof caches !== 'undefined' && caches.default) {
        // @ts-ignore
        const cachedMatch = await caches.default.match(
          `https://streamloom.internal/edge-streams/${encodeURIComponent(channelId)}`
        )
        if (cachedMatch) {
          const cachedData = await cachedMatch.json()
          if (cachedData.workingStream && candidateUrls.includes(cachedData.workingStream)) {
            // Prioritize cached working candidate to index 0
            candidateUrls = [
              cachedData.workingStream,
              ...candidateUrls.filter((u) => u !== cachedData.workingStream),
            ]
          }
        }
      }
    } catch {
      // Ignore cache lookup errors
    }
  }

  const customUa = urlObj.searchParams.get('ua') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  const customRef = urlObj.searchParams.get('ref') || ''

  let lastError: string | null = null

  // Fallback loop over candidates
  for (let i = 0; i < candidateUrls.length; i++) {
    const candidate = candidateUrls[i]

    let parsedTarget: URL
    try {
      parsedTarget = new URL(candidate)
      if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
        continue
      }
    } catch {
      continue
    }

    const headers = new Headers()
    headers.set('User-Agent', customUa)
    headers.set('Referer', customRef || parsedTarget.origin)
    const range = request.headers.get('Range')
    if (range) {
      headers.set('Range', range)
    }

    try {
      const controller = new AbortController()
      const timeoutMs = candidateUrls.length > 1 ? 5000 : 10000
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const upstreamResponse = await fetch(parsedTarget.toString(), {
        method: request.method,
        headers,
        redirect: 'follow',
        signal: controller.signal,
      })
      clearTimeout(timer)

      const contentType = (upstreamResponse.headers.get('content-type') || '').toLowerCase()

      // If upstream responded with HTML (error page, challenge, or paywall), reject
      if (contentType.includes('text/html')) {
        const htmlSnippet = await upstreamResponse.text()
        const isActuallyHtml = htmlSnippet.trimStart().toLowerCase().startsWith('<!doctype') || htmlSnippet.trimStart().toLowerCase().startsWith('<html')
        if (isActuallyHtml) {
          lastError = `Candidate ${candidate} returned HTML error page`
          continue
        }
      }

      if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        lastError = `Candidate ${candidate} returned HTTP ${upstreamResponse.status}`
        continue
      }

      // Success! Update edge cache if channelId is known
      if (channelId) {
        updateEdgeCacheWorkingStream(channelId, candidate, cfColo, context)
      }

      const responseHeaders = new Headers(upstreamResponse.headers)
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      responseHeaders.set('Access-Control-Allow-Headers', '*')
      responseHeaders.set('Access-Control-Expose-Headers', '*')
      responseHeaders.set('X-Stream-Resolved', candidate)
      responseHeaders.set('X-Edge-POP', cfColo)
      responseHeaders.delete('X-Frame-Options')
      responseHeaders.delete('Content-Security-Policy')
      // The upstream is whatever the caller named, and this response is served
      // from the app's own origin. Anyone can craft a link to
      // /api/proxy?url=<their host>, so an SVG/XHTML/XML body would otherwise run
      // its script with the app's origin if opened as a page. `sandbox` gives
      // such a document an opaque origin with no script; it has no effect on
      // playlists, segments or <video>, which are fetched rather than navigated
      // to. Cookies are dropped because the proxy never forwards them upstream.
      responseHeaders.set('Content-Security-Policy', 'sandbox')
      responseHeaders.delete('Set-Cookie')

      // Inspect text if content type indicates text/m3u8 or if filename indicates m3u8
      const likelyM3U8 =
        contentType.includes('mpegurl') ||
        contentType.includes('application/x-mpegurl') ||
        contentType.includes('application/vnd.apple.mpegurl') ||
        parsedTarget.pathname.toLowerCase().endsWith('.m3u8') ||
        candidate.toLowerCase().includes('.m3u8')

      if (likelyM3U8 || contentType.includes('text/') || contentType === '') {
        const originalText = await upstreamResponse.text()
        const trimmed = originalText.trimStart()

        // Confirm M3U8 via magic header
        if (trimmed.startsWith('#EXTM3U')) {
          let baseStr = upstreamResponse.url
          if (!baseStr || baseStr === 'about:blank') {
            baseStr = parsedTarget.toString()
          }
          const baseUrl = new URL(baseStr)
          const proxyBase = `${urlObj.origin}${urlObj.pathname}`

          const buildChildUrl = (raw: string) => {
            try {
              const absolute = new URL(raw, baseUrl).toString()
              const p = new URLSearchParams()
              p.set('url', absolute)
              if (customUa) p.set('ua', customUa)
              if (customRef) p.set('ref', customRef)
              return `${proxyBase}?${p.toString()}`
            } catch {
              return raw
            }
          }

          const rewrittenText = originalText
            .split(/\r?\n/)
            .map((line) => {
              const lineTrimmed = line.trim()
              if (!lineTrimmed) return line
              if (lineTrimmed.startsWith('#')) {
                // Rewrite URIs in tags like #EXT-X-KEY:...,URI="..." or #EXT-X-MAP:URI="..."
                if (lineTrimmed.includes('URI="')) {
                  return lineTrimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
                    return `URI="${buildChildUrl(uri)}"`
                  })
                }
                return line
              }
              // Non-comment line in M3U8 is a playlist or segment URI
              return buildChildUrl(lineTrimmed)
            })
            .join('\n')

          responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
          responseHeaders.delete('content-length')
          responseHeaders.delete('Content-Length')
          responseHeaders.delete('content-encoding')
          responseHeaders.delete('Content-Encoding')
          return new Response(rewrittenText, {
            status: upstreamResponse.status,
            headers: responseHeaders,
          })
        }

        // If text response but not EXTM3U and not video, return as-is
        responseHeaders.delete('content-length')
        responseHeaders.delete('Content-Length')
        return new Response(originalText, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        })
      }

      // Binary media segment (.ts, .m4s, .mp4)
      responseHeaders.set('Accept-Ranges', 'bytes')
      if (responseHeaders.has('content-encoding')) {
        responseHeaders.delete('content-length')
        responseHeaders.delete('Content-Length')
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('Content-Encoding')
      }
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      })
    } catch (err: any) {
      lastError = `Candidate ${candidate} error: ${err.message || err}`
      continue
    }
  }

  return new Response(`Proxy Error: All candidates failed. ${lastError || ''}`, {
    status: 502,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'text/plain',
    },
  })
}
