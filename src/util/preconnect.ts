/**
 * Opens the connection to a channel's stream server before the player asks for it.
 *
 * DNS, TCP and TLS to a stream origin the browser has not talked to yet cost one to
 * three round trips before the first playlist byte. A `<link rel=preconnect>` spends
 * them while the user is still deciding (a card focused or hovered) or while the
 * current channel plays (the next one), so the player's first request reuses a warm
 * connection. It transfers nothing and costs no Function invocation. Proxied streams
 * are skipped: they go to this origin, which is already connected.
 */

import type { EnrichedChannel } from '../hooks/useChannels'
import { orderStreamsForPlayback } from './resolution'
import { getCachedWorkingStream, isMixedContent } from './stream'
import { connectionInfo } from './bandwidth'

/*
 * hls.js (any browser with Media Source) loads with credential-less XHR, which uses
 * the anonymous connection pool; native HLS (Safari without MSE) loads `video.src`
 * with credentials, which uses the other pool. The preconnect must match to be used.
 */
const anonymousPool = typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window)

/** Browsers drop an unused preconnect after ~10 s; one older than this may be gone. */
const REUSE_MS = 10_000
/** Bounds the sockets a fast D-pad sweep across a row can open. */
const MAX_OPEN = 6
const opened = new Map<string, number>()

function preconnectOrigin(origin: string) {
  if (connectionInfo()?.saveData) return
  const now = Date.now()
  for (const [o, at] of opened) if (now - at > REUSE_MS) opened.delete(o)
  if (opened.has(origin) || opened.size >= MAX_OPEN) return
  opened.set(origin, now)
  const link = document.createElement('link')
  link.rel = 'preconnect'
  link.href = origin
  if (anonymousPool) link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
  setTimeout(() => link.remove(), REUSE_MS)
}

/** Warms the origin of the stream the player will try first for this channel. */
export function preconnectChannel(channel: EnrichedChannel) {
  const streams = channel.streams?.length ? channel.streams : channel.stream ? [channel.stream] : []
  const cached = getCachedWorkingStream(channel.id)
  const first = orderStreamsForPlayback(streams, cached?.url)[0]
  if (!first?.url) return
  if (isMixedContent(first.url) || (cached?.url === first.url && cached.useProxy)) return
  try {
    const origin = new URL(first.url).origin
    if (origin !== window.location.origin) preconnectOrigin(origin)
  } catch {
    // not a URL: nothing to warm
  }
}
