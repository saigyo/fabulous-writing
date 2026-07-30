import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'

/**
 * Modal dialog on the native <dialog> element (B3). showModal() makes the
 * rest of the page inert — the platform is the focus trap — and Escape
 * arrives as the `cancel` event. The component never closes itself: every
 * path (Escape, backdrop, buttons inside) goes through onClose so the
 * parent's mount/unmount stays the single source of truth.
 */
export function Dialog({
  title,
  onClose,
  returnFocusTo,
  className,
  children,
}: {
  title: string
  onClose: () => void
  /** Focus target on close. Needed when the opener is unmounted by the
   * time the dialog opens (a popover menu item); without it, focus falls
   * back to whatever was active at mount. */
  returnFocusTo?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  // The cleanup closes over mount-time values, which is correct here:
  // returnFocusTo is a stable ref object (its .current is what changes),
  // so no re-subscription indirection is needed.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // Captured before showModal() moves focus into the dialog.
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    return () => {
      document.body.style.overflow = priorOverflow
      if (dialog.open) dialog.close()
      // StrictMode note (dev only): the double-invoked mount effect runs
      // this cleanup once between the two mounts, restoring focus to the
      // opener; React's autoFocus fires only on an element's first DOM
      // mount, so a dialog with an autofocused control starts with focus
      // on the opener in dev. Cosmetic, dev-only; production mounts once.
      const target = returnFocusTo?.current ?? opener
      target?.focus()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once modal lifecycle; returnFocusTo is a stable ref object
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className={className ? `app-dialog ${className}` : 'app-dialog'}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        // Backdrop clicks land on the <dialog> element itself; clicks on
        // content land on descendants — but clicks on the panel's own
        // padding also target the element, so only coordinates outside its
        // box count as backdrop. mousedown (not click): a drag that starts
        // inside and releases outside must not dismiss.
        const dialog = dialogRef.current
        if (!dialog || event.target !== dialog) return
        const rect = dialog.getBoundingClientRect()
        const insidePanel =
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        if (!insidePanel) onClose()
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  )
}
