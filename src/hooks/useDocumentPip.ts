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
        // Call requestWindow() as the very first thing, nothing awaited ahead of
        // it: Document PiP's requestWindow(), like window.open(), needs the click's
        // transient user activation, and that activation doesn't reliably survive
        // an await that can span a real task boundary. An earlier version of this
        // function awaited a "wait for the previous window to finish closing"
        // promise first — reasoned as a defence against reopening before an old
        // window was fully gone, but that promise can resolve via a setTimeout
        // fallback (util/documentPip.ts), a macrotask, not just a same-tick
        // microtask, so on the very reopen path this bug report is about (close,
        // then reopen a window later) that await was the one most likely to burn
        // the click's activation and make requestWindow() silently reject. Per the
        // WICG spec, requestWindow()'s own steps already close whatever window is
        // still open (or closing) for this tab before opening the new one, so there
        // was nothing that wait bought that the browser doesn't already handle on
        // its own.
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
