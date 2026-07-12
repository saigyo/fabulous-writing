import { useEffect, type RefObject } from 'react'

/** Close a popover/menu on any mousedown outside `ref` while `open`. */
export function useDismissOnOutsideClick(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return
    function onClickOutside(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onDismiss()
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open, ref, onDismiss])
}
