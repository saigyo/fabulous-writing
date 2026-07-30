// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

afterEach(cleanup)

function dialogEl(): HTMLDialogElement {
  const el = document.querySelector('dialog')
  if (!el) throw new Error('no dialog rendered')
  return el
}

/** Fire the native cancel event (what the browser sends on Escape).
 * happy-dom does not synthesize it from keydown, so tests dispatch it. */
function fireCancel(el: HTMLDialogElement): Event {
  const event = new Event('cancel', { cancelable: true })
  fireEvent(el, event)
  return event
}

describe('Dialog', () => {
  it('opens as a modal with a labelled title', () => {
    render(
      <Dialog title="Settings" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    )
    const dialog = dialogEl()
    expect(dialog.open).toBe(true)
    const heading = screen.getByRole('heading', { name: 'Settings' })
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id)
  })

  it('routes Escape (cancel) to onClose and keeps the element under React control', () => {
    const onClose = vi.fn()
    render(
      <Dialog title="T" onClose={onClose}>
        <p>body</p>
      </Dialog>,
    )
    const event = fireCancel(dialogEl())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(dialogEl().open).toBe(true) // parent unmounts it; it never self-closes
  })

  it('dismisses on backdrop mousedown but not on content or padding mousedown', () => {
    const onClose = vi.fn()
    render(
      <Dialog title="T" onClose={onClose}>
        <button>inner</button>
      </Dialog>,
    )
    // Outside coordinates on an inner target: physically impossible in a
    // browser, but it exercises the target guard independently of the rect
    // guard — with default (0,0) coords the rect check would mask a deleted
    // target check (happy-dom rects are 0×0 at the origin).
    fireEvent.mouseDown(screen.getByText('inner'), { clientX: -10, clientY: -10 })
    expect(onClose).not.toHaveBeenCalled()
    // A click on the panel's own padding targets the <dialog> element too
    // but lies inside its box — must NOT dismiss. happy-dom rects are 0×0
    // at (0,0), so the default (0,0) coordinates land exactly on the rect.
    fireEvent.mouseDown(dialogEl())
    expect(onClose).not.toHaveBeenCalled()
    // Outside the box: a true ::backdrop click.
    fireEvent.mouseDown(dialogEl(), { clientX: -10, clientY: -10 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('locks body scroll while open and restores the prior value', () => {
    document.body.style.overflow = 'auto'
    const { unmount } = render(
      <Dialog title="T" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    )
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
    document.body.style.overflow = ''
  })

  it('returns focus to returnFocusTo on close', () => {
    function Harness() {
      const openerRef = useRef<HTMLButtonElement>(null)
      const [open, setOpen] = useState(true)
      return (
        <>
          <button ref={openerRef}>opener</button>
          {open && (
            <Dialog title="T" onClose={() => setOpen(false)} returnFocusTo={openerRef}>
              <p>body</p>
            </Dialog>
          )}
        </>
      )
    }
    render(<Harness />)
    fireCancel(dialogEl())
    expect(document.activeElement).toBe(screen.getByText('opener'))
  })

  it('falls back to the element that was focused at mount', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && (
            <Dialog title="T" onClose={() => setOpen(false)}>
              <button>inside</button>
            </Dialog>
          )}
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByText('open')
    opener.focus()
    fireEvent.click(opener)
    // Move focus into the dialog explicitly: happy-dom's showModal() does
    // not move focus by itself, and without this step the assertion below
    // could not tell "restored" from "never left" — the restore mutation
    // (Task 1 Step 5 #4) must be able to fail this test.
    screen.getByText('inside').focus()
    fireCancel(dialogEl())
    expect(document.activeElement).toBe(opener)
  })
})
