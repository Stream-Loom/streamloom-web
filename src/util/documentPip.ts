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
 * Closes a Document PiP window. Fire-and-forget on purpose: a future `requestWindow()`
 * call doesn't need to wait for this to finish — per the WICG spec, requestWindow()'s
 * own steps already close whatever tab-global PiP window is still open (or closing)
 * before opening the new one — and waiting here would only risk burning the transient
 * user activation the *next* open() call needs.
 */
export function closeDocumentPipWindow(win: Window): void {
  win.close()
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
