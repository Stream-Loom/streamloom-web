import { test, expect } from '@playwright/test'
import { onRequest as iconsHandler } from '../functions/api/icons/[channelId]'
import { onRequest as streamsHandler } from '../functions/api/streams/index'
import { onRequest as proxyHandler } from '../functions/api/proxy'

/**
 * The public edge routes must not be a way to write into the shared R2 bucket or
 * to make the edge fetch an address a stranger chose.
 *
 * These call the real Pages Function handlers (not the Vite dev stand-ins) with
 * an in-memory R2 double that records every mutation, and a stubbed `fetch` that
 * records every outbound request. No network and no Cloudflare runtime needed.
 */

const ORIGIN = 'https://streamloom.example'
const ATTACKER = 'https://attacker.example'

interface FakeObject {
  bytes: Uint8Array
  contentType: string
}

/** Minimal R2 double: reads are served from `objects`, every other call is recorded. */
function makeBucket(objects: Record<string, FakeObject> = {}) {
  const mutations: string[] = []
  const bucket = {
    async get(key: string) {
      const o = objects[key]
      if (!o) return null
      return {
        body: new Response(o.bytes).body,
        size: o.bytes.byteLength,
        httpEtag: '"test-etag"',
        httpMetadata: { contentType: o.contentType },
      }
    },
    async head(key: string) {
      return objects[key] ? { key } : null
    },
    async put(key: string) {
      mutations.push(`put ${key}`)
    },
    async delete(key: string) {
      mutations.push(`delete ${key}`)
    },
  }
  return { bucket, mutations, objects }
}

/** Runs a handler the way Pages does, then drains everything it deferred with waitUntil. */
async function call(
  handler: (ctx: any) => Promise<Response>,
  request: Request,
  env: Record<string, unknown>,
  params: Record<string, string> = {},
): Promise<Response> {
  const deferred: Promise<unknown>[] = []
  const response = await handler({
    request,
    params,
    env,
    waitUntil: (p: Promise<unknown>) => deferred.push(p),
  })
  await Promise.allSettled(deferred)
  return response
}

/** Replaces global fetch for one test and reports every outbound URL. */
function stubFetch(respond: (url: string) => Response) {
  const original = globalThis.fetch
  const outbound: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    outbound.push(url)
    return respond(url)
  }) as typeof fetch
  return {
    outbound,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])

test.describe('/api/icons is read-only', () => {
  const icon = (id: string, method: string, init: RequestInit = {}) =>
    new Request(`${ORIGIN}/api/icons/${id}`, { method, ...init })

  test('GET still serves a stored icon with the long-lived cache headers', async () => {
    const { bucket } = makeBucket({ 'icons/bbc-one.webp': { bytes: WEBP, contentType: 'image/webp' } })
    const res = await call(iconsHandler, icon('bbc-one', 'GET'), { ICONS_BUCKET: bucket }, { channelId: 'bbc-one' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('etag')).toBe('"test-etag"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP)
  })

  test('HEAD answers without a body, and a missing icon is a 404', async () => {
    const { bucket } = makeBucket({ 'icons/bbc-one.webp': { bytes: WEBP, contentType: 'image/webp' } })
    const env = { ICONS_BUCKET: bucket }

    const head = await call(iconsHandler, icon('bbc-one', 'HEAD'), env, { channelId: 'bbc-one' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const missing = await call(iconsHandler, icon('nobody', 'GET'), env, { channelId: 'nobody' })
    expect(missing.status).toBe(404)
  })

  test('an unauthenticated POST is refused: no write, no outbound fetch', async () => {
    const { bucket, mutations } = makeBucket()
    const net = stubFetch(() => new Response(WEBP, { headers: { 'content-type': 'image/webp' } }))
    try {
      const res = await call(
        iconsHandler,
        icon('victim', 'POST', {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `${ATTACKER}/evil.webp` }),
        }),
        { ICONS_BUCKET: bucket },
        { channelId: 'victim' },
      )
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
      expect(mutations).toEqual([])
      expect(net.outbound).toEqual([])
    } finally {
      net.restore()
    }
  })

  test('a cross-origin POST is refused, and the preflight does not offer POST', async () => {
    const { bucket, mutations } = makeBucket()
    const net = stubFetch(() => new Response(WEBP, { headers: { 'content-type': 'image/webp' } }))
    try {
      const env = { ICONS_BUCKET: bucket }
      const post = await call(
        iconsHandler,
        icon('victim', 'POST', {
          headers: { origin: ATTACKER, 'content-type': 'text/plain' },
          body: JSON.stringify({ url: `${ATTACKER}/evil.webp` }),
        }),
        env,
        { channelId: 'victim' },
      )
      expect(post.status).toBe(405)

      const preflight = await call(
        iconsHandler,
        icon('victim', 'OPTIONS', {
          headers: { origin: ATTACKER, 'access-control-request-method': 'POST' },
        }),
        env,
        { channelId: 'victim' },
      )
      const allowed = (preflight.headers.get('access-control-allow-methods') || '').split(/\s*,\s*/)
      expect(allowed).not.toContain('POST')
      expect(mutations).toEqual([])
      expect(net.outbound).toEqual([])
    } finally {
      net.restore()
    }
  })

  test('PUT, PATCH and DELETE are refused and never touch an existing icon', async () => {
    const { bucket, mutations, objects } = makeBucket({
      'icons/bbc-one.webp': { bytes: WEBP, contentType: 'image/webp' },
    })
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await call(
        iconsHandler,
        icon('bbc-one', method, { body: method === 'DELETE' ? undefined : 'x' }),
        { ICONS_BUCKET: bucket },
        { channelId: 'bbc-one' },
      )
      expect(res.status, method).toBe(405)
    }
    expect(mutations).toEqual([])
    expect(objects['icons/bbc-one.webp'].bytes).toBe(WEBP)
  })

  test('a channel id with path characters cannot select another object', async () => {
    const { bucket } = makeBucket({ 'icons/secret.webp': { bytes: WEBP, contentType: 'image/webp' } })
    for (const id of ['../secret', '..%2Fsecret', 'a/b', 'a b']) {
      const res = await call(iconsHandler, icon('x', 'GET'), { ICONS_BUCKET: bucket }, { channelId: id })
      expect(res.status, id).toBe(400)
    }
  })

  test('the Vite dev stand-in has the same shape: read 404, write 405', async ({ request }) => {
    expect((await request.get('/api/icons/some-channel')).status()).toBe(404)
    const post = await request.post('/api/icons/some-channel', { data: { url: `${ATTACKER}/evil.webp` } })
    expect(post.status()).toBe(405)
  })
})

test.describe('/api/streams does not write to R2', () => {
  test('a probe triggered by an anonymous GET leaves the bucket untouched', async () => {
    const { bucket, mutations } = makeBucket()
    const net = stubFetch(
      () =>
        new Response('#EXTM3U\n#EXTINF:4,\nseg.ts\n', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
    )
    try {
      const url = `${ORIGIN}/api/streams?channelId=victim&urls=${encodeURIComponent(`${ATTACKER}/a.m3u8,${ATTACKER}/b.m3u8,${ATTACKER}/c.m3u8`)}`
      const res = await call(streamsHandler, new Request(url), { ICONS_BUCKET: bucket })

      // The probe still works and still answers the caller...
      expect(res.status).toBe(200)
      const body = (await res.json()) as { workingStream: string | null }
      expect(body.workingStream).toBe(`${ATTACKER}/a.m3u8`)
      expect(net.outbound.length).toBeGreaterThan(0)
      // ...including the background candidates, but nothing reaches R2.
      expect(mutations).toEqual([])
    } finally {
      net.restore()
    }
  })
})

test.describe('/api/proxy responses cannot run as a page on the app origin', () => {
  const proxy = (target: string) =>
    new Request(`${ORIGIN}/api/proxy?url=${encodeURIComponent(target)}`)

  test('an attacker-hosted SVG is sandboxed and its cookie is dropped', async () => {
    const net = stubFetch(
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
          status: 200,
          headers: [
            ['content-type', 'image/svg+xml'],
            ['set-cookie', 'session=attacker; Path=/'],
            ['content-security-policy', "default-src *"],
          ],
        }),
    )
    try {
      const res = await call(proxyHandler, proxy(`${ATTACKER}/x.svg`), {})
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe('sandbox')
      expect(res.headers.get('set-cookie')).toBeNull()
    } finally {
      net.restore()
    }
  })

  test('an HLS playlist is still rewritten through the proxy, with the sandbox header', async () => {
    const net = stubFetch(
      () =>
        new Response('#EXTM3U\n#EXTINF:4,\nsegment0.ts\n', {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
    )
    try {
      const res = await call(proxyHandler, proxy('https://cdn.example/live/index.m3u8'), {})
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('mpegurl')
      expect(res.headers.get('content-length')).toBeNull()
      expect(res.headers.get('content-security-policy')).toBe('sandbox')
      const text = await res.text()
      expect(text).toContain(`${ORIGIN}/api/proxy?url=${encodeURIComponent('https://cdn.example/live/segment0.ts')}`)
    } finally {
      net.restore()
    }
  })
})
