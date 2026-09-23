import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killLoggedProcess, spawnLogged, waitUntilReady, type LoggedProcess } from './support/wranglerDev'

/**
 * Regression test for the 2026-09-23 incident: a same-tab navigation to `/admin`, made
 * *after* the main site was already open in that tab, showed "The portal could not be
 * reached." — while a fresh private window opening `/admin` directly worked fine.
 *
 * Root cause: `/admin` sits behind Cloudflare Access, and Access only attaches its
 * session cookie to a browser once a *real network request* reaches Cloudflare's edge
 * and completes its login handshake. Before the fix, `vite.config.ts`'s Workbox
 * `navigateFallback` answered any unmatched navigation — including `/admin` — straight
 * from the service worker's own Cache Storage, with no network round trip at all. Once
 * the worker registered by visiting the main site first, the *next* same-tab navigation
 * to `/admin` never reached the edge, Access never ran, and the page's own
 * `fetch('/api/picks')` then failed with no session cookie. A fresh private window has
 * no service worker yet, so its `/admin` navigation is a genuine network request and
 * Access's handshake completes normally — exactly the asymmetry reported.
 *
 * The current e2e suite cannot see this class of bug at all: every other spec runs
 * against plain `vite` dev, which hard-disables the service worker entirely
 * (`devOptions.enabled` unset). This spec builds the real production bundle and serves
 * it with `wrangler pages dev` (not `vite preview`, which does not honor
 * `public/_redirects`/`public/_headers`), so both halves of this fix — the service
 * worker's routing and the Cloudflare Pages rewrite it depends on — run for real.
 *
 * What this does NOT prove: that Cloudflare Access itself then completes its login
 * handshake and sets `CF_Authorization`. Access is a Cloudflare edge product with no
 * local emulation — `wrangler pages dev` does not run it. What it proves, locally and
 * reliably, is the actual defect: whether the `/admin` navigation reaches the network at
 * all, which is the one thing Access's handshake depends on and the one thing a service
 * worker can silently prevent.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER_PORT = 5201
const WRANGLER_URL = `http://127.0.0.1:${WRANGLER_PORT}`
const READY_TIMEOUT_MS = 60_000
const BUILD_TIMEOUT_MS = 120_000

/** Real production bundle, deliberately — the service worker only exists in this build. */
function buildApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    const build = spawn('npx', ['vite', 'build'], { cwd: PROJECT_ROOT, stdio: 'pipe' })
    let log = ''
    build.stdout?.on('data', (d) => (log += String(d)))
    build.stderr?.on('data', (d) => (log += String(d)))
    const timer = setTimeout(() => {
      build.kill()
      reject(new Error(`vite build did not finish within ${BUILD_TIMEOUT_MS}ms.\n${log}`))
    }, BUILD_TIMEOUT_MS)
    build.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`vite build exited with code ${code}.\n${log}`))
    })
  })
}

test.describe('/admin navigation vs the service worker (regression: 2026-09-23 Cloudflare Access bypass)', () => {
  let wrangler: LoggedProcess | null = null

  test.beforeAll(async () => {
    await buildApp()
    // The real `wrangler.jsonc` at the project root, not an isolated fixture: unlike
    // `workerd-smoke.spec.ts`, this test wants the project's actual `assets.directory`,
    // `public/_headers` and `public/_redirects` exactly as deployed. Local R2 bindings
    // are emulated by wrangler without any real credential (no `--remote`), and neither
    // test below reaches `/api/picks`'s Access check, so no catalogue or Access mocking
    // is wired up — this suite is narrowly about the navigation/service-worker layer.
    wrangler = spawnLogged(
      'npx',
      ['wrangler', 'pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', String(WRANGLER_PORT)],
      { cwd: PROJECT_ROOT },
    )
    await waitUntilReady(`${WRANGLER_URL}/`, READY_TIMEOUT_MS)
  })

  test.afterAll(() => {
    killLoggedProcess(wrangler)
  })

  test('a same-tab navigation to /admin, after the service worker is active, reaches the network — not the cache', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: WRANGLER_URL })
    const page = await context.newPage()
    try {
      await page.goto('/')

      // `clientsClaim` (forced on by `registerType: 'autoUpdate'`) makes a newly activated
      // worker take control of this very page without a reload, but only once activation
      // finishes — wait for both, not just `ready`, or the next navigation could race a
      // worker that isn't controlling anything yet and pass for the wrong reason.
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready
        if (navigator.serviceWorker.controller) return
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
        })
      })
      // Sanity check on the premise itself: if this ever comes back false, the assertion
      // below would pass vacuously (nothing was intercepted to bypass), not because the
      // fix works.
      expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

      // This is exactly what changing the address bar to /admin in the same tab does.
      const res = await page.goto('/admin')
      expect(res).not.toBeNull()
      expect(res!.fromServiceWorker()).toBe(false)
    } finally {
      await context.close()
    }
  })

  test('a fresh context with no service worker still gets a real 200 for /admin, not a redirect (guards the original Safari deep-link fix)', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: WRANGLER_URL, serviceWorkers: 'block' })
    const page = await context.newPage()
    try {
      const res = await page.goto('/admin')
      expect(res).not.toBeNull()
      expect(res!.status()).toBe(200)
      expect(res!.request().redirectedFrom()).toBeNull()
    } finally {
      await context.close()
    }
  })
})
