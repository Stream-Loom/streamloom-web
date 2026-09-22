/**
 * Kicks off the backend's fast-track probe (ADR-0043, WO-19) for channels a save just pinned
 * that were not already pinned before it — the identity card (ADR-0042) already made them
 * visible; this is what makes them playable within seconds instead of waiting for the next
 * scheduled sync.
 *
 * Deliberately the only thing in this project that holds a GitHub credential, and deliberately
 * the *only* capability that credential has: `repository_dispatch` cannot read anything, write
 * anything in the repository, or trigger any workflow other than the one keyed to
 * `fast-track-pick`. It is not a Supabase or Upstash credential and cannot reach either.
 *
 * Never allowed to fail a save. The caller (`handleWrite`) runs this through `context.waitUntil`
 * after the picks write has already succeeded and already returned its response — a dispatch
 * that fails, times out, or the token being unset entirely all mean "this save's picks stay on
 * the identity card a little longer", never "the save did not happen".
 */

const REPO = 'Stream-Loom/streamloom-backend'
const DISPATCH_URL = `https://api.github.com/repos/${REPO}/dispatches`
const EVENT_TYPE = 'fast-track-pick'

/** Bounds one save's cost: a bulk-add pins many channels at once, this dispatches for at most this many. */
export const MAX_FAST_TRACK_IDS = 10

const FETCH_TIMEOUT_MS = 10_000

/**
 * True when `env` carries a token to dispatch with. Absent is a legitimate, quiet state — the
 * fast-track feature simply is not configured yet — never a reason to warn on every save.
 */
export function fastTrackConfigured(env: unknown): boolean {
  const token = (env as { GITHUB_DISPATCH_TOKEN?: unknown } | undefined)?.GITHUB_DISPATCH_TOKEN
  return typeof token === 'string' && token.trim().length > 0
}

/**
 * Dispatches one `repository_dispatch` naming up to [MAX_FAST_TRACK_IDS] channel ids. Resolves on
 * a 2xx, rejects otherwise (a non-2xx status, a network error, or a timeout) — the caller decides
 * what "otherwise" means, which is always "log it, never surface it to the save's own response".
 *
 * A no-op, resolving immediately, when the token is unset or `channelIds` is empty: dispatching
 * with nothing to fast-track would just be a GitHub Actions run that immediately does nothing.
 */
export async function dispatchFastTrack(env: unknown, channelIds: readonly string[]): Promise<void> {
  if (!fastTrackConfigured(env) || channelIds.length === 0) return
  const token = (env as { GITHUB_DISPATCH_TOKEN: string }).GITHUB_DISPATCH_TOKEN.trim()
  const ids = channelIds.slice(0, MAX_FAST_TRACK_IDS)

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(DISPATCH_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'streamloom-web-picks-portal',
      },
      body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { channelIds: ids } }),
    })
    // A successful dispatch is 204 with no body (GitHub's own convention for this endpoint).
    if (!res.ok) throw new Error(`GitHub dispatch refused: ${res.status} ${await res.text().catch(() => '')}`)
  } finally {
    clearTimeout(timer)
  }
}
