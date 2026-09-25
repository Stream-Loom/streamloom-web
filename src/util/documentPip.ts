/**
 * Document Picture-in-Picture (Chrome/Edge desktop only, Safari has neither this API
 * nor the older element-PiP one on desktop): a real floating window with its own
 * document, so the mini-player can carry custom zap controls instead of the handful
 * of buttons the browser's native video PiP window allows.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
  readonly window: Window | null
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture
  }
}

export function isDocumentPipSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window
}

/**
 * There is at most one Document PiP window per tab — it's a browser-level singleton,
 * not something scoped to whichever component happened to open it. Closing one and
 * immediately requesting a new one (leaving the Watch route via the app's own back
 * button, then reopening the mini-player on a different channel a moment later) needs
 * the first window's close to actually finish first: `window.close()` on it isn't
 * guaranteed synchronous, and asking for a new window before it has really gone either
 * hands back that same dying window (an inert one nothing then renders into) or throws.
 * Module-level, not per-hook-instance, because the constraint itself is tab-global and
 * must survive whichever component happened to be the one that opened the last window.
 */
let closing: Promise<void> | null = null

/** Closes a Document PiP window and returns a promise that resolves once it's actually gone. */
export function closeDocumentPipWindow(win: Window): Promise<void> {
  closing = new Promise((resolve) => {
    const done = () => resolve()
    win.addEventListener('pagehide', done, { once: true })
    // Belt-and-braces: a programmatic close() isn't contractually guaranteed to fire
    // pagehide on every browser/version, so don't let a future open() wait forever.
    setTimeout(done, 500)
  })
  win.close()
  return closing
}

/** Resolves once any Document PiP window this tab was closing has actually finished closing. */
export async function waitForPipWindowToClose(): Promise<void> {
  if (closing) await closing
}

/** Copies the page's stylesheets into a PiP window so moved/portalled content keeps its styling. */
export function copyStylesInto(pipDocument: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.href) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        pipDocument.head.appendChild(link)
      } else if (sheet.cssRules) {
        const style = document.createElement('style')
        style.textContent = Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join('\n')
        pipDocument.head.appendChild(style)
      }
    } catch {
      // Cross-origin stylesheet; cssRules throws, and there is nothing to copy.
    }
  }
}
