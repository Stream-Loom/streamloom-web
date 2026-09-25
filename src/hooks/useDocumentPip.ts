import { useCallback, useEffect, useRef, useState } from 'react'
import { closeDocumentPipWindow, copyStylesInto, isDocumentPipSupported } from '../util/documentPip'

/**
 * Opens and tracks a Document Picture-in-Picture window. Doesn't move any content
 * itself — the caller reparents its own video node and portals its own controls into
 * the returned `pipWindow`, since only the caller knows what belongs in the window.
 *
 * `onWillClose` runs synchronously inside the `pagehide` handler, before any React
 * state update — both the app's own close button and the browser's native close-x on
 * the PiP window converge on this one event. React batches the `setPipWindow(null)`
 * this triggers, so a caller that instead waited for `pipWindow` to become null before
 * moving its video node back would do that move on a later render, after the PiP
 * window's document (and the "still fully active" guarantee media state needs) may
 * already be gone. `onWillClose` is the caller's chance to move it back immediately.
 */
export function useDocumentPip(onWillClose?: () => void) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const pipWindowRef = useRef<Window | null>(null)
  const onWillCloseRef = useRef(onWillClose)
  const isOpeningRef = useRef(false)
  const isSupported = isDocumentPipSupported()

  useEffect(() => {
    onWillCloseRef.current = onWillClose
  }, [onWillClose])

  const close = useCallback(() => {
    const win = pipWindowRef.current
    if (win) void closeDocumentPipWindow(win)
  }, [])

  const open = useCallback(
    async (options?: { width?: number; height?: number }) => {
      if (!isSupported || isOpeningRef.current) return null
      const dpip = window.documentPictureInPicture!
      isOpeningRef.current = true
      let win: Window
      try {
        // A leftover window from a different VideoPlayer instance (the previous
        // channel, closed via the app's own back button rather than the PiP
        // window's own close) can still be this tab's live documentPictureInPicture
        // window here — window.close() doesn't promise to be instant, and in
        // practice requestWindow() reopening right after hasn't reliably produced
        // a new window for that channel (confirmed still broken after removing an
        // earlier awaited "wait for it to close" step, which was the previous
        // theory). Force it closed now, synchronously, and immediately request the
        // new one in the same call stack — nothing awaited in between — so this
        // click's transient user activation carries straight through to
        // requestWindow() either way.
        // Temporary diagnostic (remove once the reopen-after-back bug is confirmed
        // fixed): settles whether this branch is even reached on the actual repro.
        console.log('[document-pip] dpip.window before open()', dpip.window)
        if (dpip.window) dpip.window.close()
        win = await dpip.requestWindow(options)
      } finally {
        isOpeningRef.current = false
      }
      copyStylesInto(win.document)
      win.document.body.style.margin = '0'
      win.document.body.style.background = '#000'
      win.addEventListener(
        'pagehide',
        () => {
          onWillCloseRef.current?.()
          pipWindowRef.current = null
          setPipWindow(null)
        },
        { once: true }
      )
      pipWindowRef.current = win
      setPipWindow(win)
      return win
    },
    [isSupported]
  )

  // Belt-and-braces: closing this way (rather than the window's own close button)
  // still fires 'pagehide' above, which does the actual video move-back — this just
  // makes sure the window itself doesn't outlive the component.
  useEffect(() => {
    return () => {
      const win = pipWindowRef.current
      if (win) void closeDocumentPipWindow(win)
    }
  }, [])

  return { isSupported, pipWindow, open, close }
}
