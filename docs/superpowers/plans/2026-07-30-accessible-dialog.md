# B3 Accessible Dialog Pattern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable accessible modal dialog (native `<dialog>` + `showModal()`) adopted by FolderDefaults, the change-password form, and both delete confirmations; the admin own-row password reset becomes disabled with a hint.

**Architecture:** One `Dialog` primitive in a new `frontend/src/ui/` directory wraps `<dialog>`: the platform provides the focus trap (inert page) and Escape (`cancel` event); the component adds scroll lock, backdrop-mousedown dismissal, and explicit focus restore. A `ConfirmDialog` face builds on it. Consumers mount/unmount it; it never closes itself except via `onClose`.

**Tech Stack:** React 19 + TypeScript, Vitest + happy-dom + @testing-library/react (all already present — no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-30-accessible-dialog-design.md` (governs on conflict).

## Global Constraints

- Frontend-only; the backend, live DB, and dev servers on ports 5173/8000 are never touched.
- No new dependencies.
- Every new i18n key is added to `src/i18n/messages.ts` (type) AND all 7 catalogs: en, de, es, fr, it, ja, zh. UI copy stays in each catalog's current impersonal register.
- No `dangerouslySetInnerHTML`; no dynamic `href`/`src` from user or LLM content.
- Gates before every commit: `npm test -- --run` green and `npm run build` clean (run from `frontend/`).
- Mutation-verify every guard test: delete the guard, watch the test fail, restore.
- Never widen a wall-clock test bound.
- New test files start with `// @vitest-environment happy-dom` (repo convention).
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

---

### Task 1: `Dialog` primitive

**Files:**
- Create: `frontend/src/ui/Dialog.tsx`
- Modify: `frontend/src/App.css` (append base dialog styles; near the `.dialog-overlay` block at ~line 1795)
- Test: `frontend/src/ui/Dialog.test.tsx` (new)

**Interfaces:**
- Consumes: nothing from this plan.
- Produces: `Dialog({ title: string, onClose: () => void, returnFocusTo?: RefObject<HTMLElement | null>, className?: string, children: ReactNode })` — later tasks import `{ Dialog } from '../ui/Dialog'`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/ui/Dialog.test.tsx
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

  it('dismisses on backdrop mousedown but not on content mousedown', () => {
    const onClose = vi.fn()
    render(
      <Dialog title="T" onClose={onClose}>
        <button>inner</button>
      </Dialog>,
    )
    fireEvent.mouseDown(screen.getByText('inner'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(dialogEl()) // backdrop clicks land on the element itself
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/ui/Dialog.test.tsx`
Expected: FAIL — cannot resolve `./Dialog`.

- [ ] **Step 3: Implement `Dialog`**

```tsx
// frontend/src/ui/Dialog.tsx
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
        // content land on descendants. mousedown (not click): a drag that
        // starts inside and releases outside must not dismiss.
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  )
}
```

Append to `frontend/src/App.css` (directly above the `.dialog-overlay` block; Task 3 deletes that block):

```css
/* Reusable modal dialog (B3). Panel look shared by all dialogs; width and
   inner layout are per-dialog. display is scoped to [open]: an unscoped
   `display: flex` would override the UA's display:none for closed dialogs. */
dialog.app-dialog[open] {
  display: flex;
  flex-direction: column;
}
dialog.app-dialog {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  max-height: 80vh;
  overflow-y: auto;
}
dialog.app-dialog::backdrop {
  background: rgba(0, 0, 0, 0.35);
}
dialog.app-dialog h2 {
  font-size: 0.95rem;
  margin: 0 0 0.25rem;
  color: var(--text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run src/ui/Dialog.test.tsx` then the full gates (`npm test -- --run`, `npm run build`).
Expected: PASS, build clean.

- [ ] **Step 5: Mutation-verify the guard tests**

One at a time — delete, watch the named test fail, restore:
1. Remove `event.preventDefault()` in `onCancel` → "routes Escape…" fails on `defaultPrevented`.
2. Remove the `event.target === dialogRef.current` condition (always call `onClose()`) → "dismisses on backdrop…" fails on the inner-mousedown assertion.
3. Remove the `document.body.style.overflow` restore in the cleanup → the scroll-lock test fails on `'auto'`.
4. Remove the `target?.focus()` line → both focus-restore tests fail.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ui/Dialog.tsx frontend/src/ui/Dialog.test.tsx frontend/src/App.css
git commit -m "feat(ui): accessible modal Dialog on native <dialog> (B3, #36)"
```

---

### Task 2: `ConfirmDialog` + generic button keys

**Files:**
- Create: `frontend/src/ui/ConfirmDialog.tsx`
- Modify: `frontend/src/i18n/messages.ts` (interface), `frontend/src/i18n/{en,de,es,fr,it,ja,zh}.ts`
- Modify: `frontend/src/App.css` (append confirm styles below the Task 1 block)
- Test: `frontend/src/ui/ConfirmDialog.test.tsx` (new)

**Interfaces:**
- Consumes: `Dialog` from Task 1.
- Produces: `ConfirmDialog({ title: string, message: string, confirmLabel?: string, onConfirm: () => void, onCancel: () => void })`; i18n keys `dialogCancel: string`, `dialogConfirm: string`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/ui/ConfirmDialog.test.tsx
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../i18n/en'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

function renderConfirm(overrides: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn()
  const onCancel = overrides.onCancel ?? vi.fn()
  render(
    <ConfirmDialog
      title="Delete folder"
      message="Delete 'Drafts'?"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  )
  return { onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  it('starts with focus on Cancel (destructive-safe default)', () => {
    renderConfirm()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: en.dialogCancel }),
    )
  })

  it('confirm fires onConfirm only', () => {
    const { onConfirm, onCancel } = renderConfirm()
    fireEvent.click(screen.getByRole('button', { name: en.dialogConfirm }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancel button and Escape both fire onCancel', () => {
    const { onConfirm, onCancel } = renderConfirm()
    fireEvent.click(screen.getByRole('button', { name: en.dialogCancel }))
    const dialog = document.querySelector('dialog')
    if (!dialog) throw new Error('no dialog')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/ui/ConfirmDialog.test.tsx`
Expected: FAIL — cannot resolve `./ConfirmDialog` (and `en.dialogCancel` is a type error until the keys land).

- [ ] **Step 3: Add the i18n keys**

In `frontend/src/i18n/messages.ts`, next to `passwordCancel: string` (~line 238), add:

```ts
  dialogCancel: string
  dialogConfirm: string
```

Catalog values (place next to each catalog's `passwordCancel`):

| Catalog | `dialogCancel` | `dialogConfirm` |
| --- | --- | --- |
| en.ts | `'Cancel'` | `'Confirm'` |
| de.ts | `'Abbrechen'` | `'Bestätigen'` |
| es.ts | `'Cancelar'` | `'Confirmar'` |
| fr.ts | `'Annuler'` | `'Confirmer'` |
| it.ts | `'Annulla'` | `'Conferma'` |
| ja.ts | `'キャンセル'` | `'確認'` |
| zh.ts | `'取消'` | `'确认'` |

- [ ] **Step 4: Implement `ConfirmDialog`**

```tsx
// frontend/src/ui/ConfirmDialog.tsx
import { useMessages } from '../i18n'
import { Dialog } from './Dialog'

/** Confirm face of Dialog (B3): message + Cancel / danger-styled confirm.
 * Cancel holds initial focus so Enter on a just-opened dialog never
 * destroys anything. Escape and backdrop cancel via Dialog's onClose. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const m = useMessages()
  return (
    <Dialog title={title} onClose={onCancel} className="confirm-dialog">
      <p>{message}</p>
      <div className="confirm-dialog-buttons">
        {/* autoFocus: React focuses on mount, deterministic in happy-dom
            (the platform's autofocus-on-showModal is not). */}
        <button type="button" autoFocus onClick={onCancel}>
          {m.dialogCancel}
        </button>
        <button type="button" className="confirm-dialog-danger" onClick={onConfirm}>
          {confirmLabel ?? m.dialogConfirm}
        </button>
      </div>
    </Dialog>
  )
}
```

Append to `frontend/src/App.css` (below the Task 1 dialog block; `#e5484d` is the app's existing danger red, see `.doc-menu-delete`):

```css
.confirm-dialog {
  width: 320px;
}
.confirm-dialog p {
  margin: 0.25rem 0 0.75rem;
  font-size: 0.85rem;
}
.confirm-dialog-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.confirm-dialog-danger {
  color: #e5484d;
  border-color: #e5484d;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run src/ui/ConfirmDialog.test.tsx`, then full gates.
Expected: PASS, build clean.

- [ ] **Step 6: Mutation-verify**

Remove `autoFocus` from the Cancel button → the initial-focus test fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ui/ConfirmDialog.tsx frontend/src/ui/ConfirmDialog.test.tsx frontend/src/i18n frontend/src/App.css
git commit -m "feat(ui): ConfirmDialog + dialogCancel/dialogConfirm keys (B3, #36)"
```

---

### Task 3: Migrate `FolderDefaultsDialog`, delete `.dialog-overlay`

**Files:**
- Modify: `frontend/src/documents/FolderDefaultsDialog.tsx:142-151,307-309` (the shell; fields unchanged)
- Modify: `frontend/src/App.css` (~1795: delete `.dialog-overlay`; slim `.folder-defaults-dialog`)
- Test: existing `frontend/src/documents/FolderDefaultsDialog.policy.test.tsx` and any DocumentSidebar test rendering the dialog must stay green.

**Interfaces:**
- Consumes: `Dialog` from Task 1 (`import { Dialog } from '../ui/Dialog'`).
- Produces: nothing new — same `FolderDefaultsDialog({ folder, onClose })`.

- [ ] **Step 1: Replace the shell**

The component's return currently wraps content in `div.dialog-overlay` + `div.folder-defaults-dialog` and renders its own `<h2>`. Replace with:

```tsx
  return (
    <Dialog
      title={`${m.folderDefaults}: ${folder.name}`}
      onClose={onClose}
      className="folder-defaults-dialog"
    >
      {/* fields exactly as before, starting with the language <label>;
          the old <h2>{m.folderDefaults}: {folder.name}</h2> is removed —
          Dialog renders the title */}
      ...
    </Dialog>
  )
```

Delete the outer `<div className="dialog-overlay" onMouseDown={...}>` (backdrop dismissal is Dialog's job now) and the inner `<div className="folder-defaults-dialog">`.

- [ ] **Step 2: CSS**

Delete the `.dialog-overlay` block entirely. Reduce `.folder-defaults-dialog` to what the base `dialog.app-dialog` does not provide:

```css
.folder-defaults-dialog {
  width: 340px;
  gap: 0.6rem;
}
```

(`background/border/radius/padding/max-height/overflow-y/display/flex-direction` all come from `dialog.app-dialog[open]` / `dialog.app-dialog`. Delete the `.folder-defaults-dialog h2` rule: the Dialog-rendered `<h2>` would still match it — the element carries both classes — but `dialog.app-dialog h2` supersedes it with identical values. Keep the `label`/`select`/`.fd-*` rules.)

- [ ] **Step 3: Verify nothing else references the deleted class**

Run: `grep -rn "dialog-overlay" frontend/src`
Expected: no matches.

- [ ] **Step 4: Run the gates**

Run: `npm test -- --run` and `npm run build`.
Expected: PASS — the policy test renders the dialog by content, not by shell classes; fix any test that queried `.dialog-overlay` to use the rendered content instead.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/documents/FolderDefaultsDialog.tsx frontend/src/App.css
git commit -m "refactor(documents): FolderDefaultsDialog onto the Dialog primitive (B3, #36)"
```

---

### Task 4: `DocumentSidebar` deletes onto `ConfirmDialog`

**Files:**
- Modify: `frontend/src/documents/DocumentSidebar.tsx` (folder-header component around lines 283-291; `DocumentItem` around lines 413-424)
- Test: `frontend/src/documents/DocumentSidebar.test.tsx` (extend)

**Interfaces:**
- Consumes: `ConfirmDialog` from Task 2 (`import { ConfirmDialog } from '../ui/ConfirmDialog'`).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

**There is no component harness to follow:** `DocumentSidebar.test.tsx` today holds only pure-helper tests (`documentTime`, `grouping`) — no env docblock, no `render`, no store seeding — and nothing in the repo renders `<DocumentSidebar>` yet. Build the harness in this task:

- Make `// @vitest-environment happy-dom` the FIRST line of the file (the existing helper tests are environment-agnostic and keep passing).
- Mock the module the delete paths call: `vi.mock('./documents', ...)` returning `vi.fn()`s for every export DocumentSidebar imports (`createNewDocument`, `initDocuments`, `moveDocumentToFolder`, `openDocument`, `removeDocument`, `removeFolder`, `renameDocument`), with `removeFolder`/`removeDocument` resolving (`vi.fn(() => Promise.resolve())`).
- Seed the store per test with one folder and one document in it — build the fixtures against the `DocumentSummary` and `Folder` types in `src/api/client.ts` (the compiler enforces the exact fields) and set them via `useStore.setState({ folders: [...], documents: [...], ... })` alongside whatever sidebar state the component reads (e.g. collapsed flag) — derive the exact store keys from `DocumentSidebar.tsx`'s `useStore` selectors.
- Open the folder/document menus the way the component labels them (read the menu-button `aria-label`s in `DocumentSidebar.tsx` and query by them).

The tests themselves:

```tsx
it('folder delete asks via ConfirmDialog and only deletes on confirm', () => {
  render(<DocumentSidebar />)
  // open the folder menu (query by its aria-label), click its delete item
  fireEvent.click(screen.getByText(en.folderDelete))
  // dialog is up, nothing deleted yet
  expect(document.querySelector('dialog')?.open).toBe(true)
  expect(vi.mocked(removeFolder)).not.toHaveBeenCalled()
  // cancel closes without deleting
  fireEvent.click(screen.getByRole('button', { name: en.dialogCancel }))
  expect(vi.mocked(removeFolder)).not.toHaveBeenCalled()
  expect(document.querySelector('dialog')).toBeNull()
  // reopen menu, click delete again, confirm deletes
  fireEvent.click(screen.getByRole('button', { name: en.dialogConfirm }))
  expect(vi.mocked(removeFolder)).toHaveBeenCalledWith(folderId)
})
```

Mirror the same shape for the document delete (`en.docDelete`, `vi.mocked(removeDocument)`, `doc.id`).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --run src/documents/DocumentSidebar.test.tsx`
Expected: FAIL — happy-dom implements no `window.confirm` at all, so the click on the delete item throws `TypeError: window.confirm is not a function` (and no dialog appears).

- [ ] **Step 3: Implement**

In the folder-header component (the one holding `defaultsOpen`, ~line 189), add:

```tsx
const [confirmingDelete, setConfirmingDelete] = useState(false)
```

Change the delete menu item (lines ~283-291):

```tsx
<button
  className="doc-menu-delete"
  onClick={() => {
    setMenuOpen(false)
    setConfirmingDelete(true)
  }}
>
  {m.folderDelete}
</button>
```

Render next to the existing `{defaultsOpen && (<FolderDefaultsDialog .../>)}`:

```tsx
{confirmingDelete && (
  <ConfirmDialog
    title={m.folderDelete}
    message={m.folderDeleteConfirm(folder.name)}
    onConfirm={() => {
      setConfirmingDelete(false)
      removeFolder(folder.id).catch(() => {
        useStore.getState().setDocListError(true)
      })
    }}
    onCancel={() => setConfirmingDelete(false)}
  />
)}
```

In `DocumentItem`, the same pattern: a `confirmingDelete` state; the delete menu item sets `setMenuOpen(false); setMoving(false); setConfirmingDelete(true)`; render:

```tsx
{confirmingDelete && (
  <ConfirmDialog
    title={m.docDelete}
    message={m.docDeleteConfirm(doc.name)}
    onConfirm={() => {
      setConfirmingDelete(false)
      void removeDocument(doc.id)
    }}
    onCancel={() => setConfirmingDelete(false)}
  />
)}
```

Verify: `grep -n "window.confirm" frontend/src` → no matches.

- [ ] **Step 4: Run tests, gates**

Run: `npm test -- --run src/documents/DocumentSidebar.test.tsx`, then full gates.
Expected: PASS.

- [ ] **Step 5: Mutation-verify**

Swap `onConfirm`'s body into `onCancel` (delete on cancel) for the folder dialog → the cancel assertion fails. Restore. Same probe for the document dialog.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/documents/DocumentSidebar.tsx frontend/src/documents/DocumentSidebar.test.tsx
git commit -m "feat(documents): delete confirmations on ConfirmDialog, drop window.confirm (B3, #36)"
```

---

### Task 5: Change-password form onto a Dialog

**Files:**
- Modify: `frontend/src/auth/AccountMenu.tsx`
- Modify: `frontend/src/App.css` (~1977: `.account-password-panel` → `.account-password-dialog`)
- Test: `frontend/src/auth/AccountMenu.test.tsx` (adapt)

**Interfaces:**
- Consumes: `Dialog` from Task 1.
- Produces: nothing new — `AccountMenu()` unchanged externally. `PasswordForm` and all its session-generation guards move verbatim.

- [ ] **Step 1: Restructure `AccountMenu`**

Remove the `view` state and the `'menu' | 'password'` union; add `const [passwordOpen, setPasswordOpen] = useState(false)`. `closeMenu` becomes just `setOpen(false)` (keep the `useCallback`; the dismiss hook depends on it). The popover render loses its conditional and always shows the menu:

```tsx
{open && (
  <div className="account-menu">
    <div className="account-who">{user.email}</div>
    <button
      type="button"
      onClick={() => {
        setOpen(false)
        setPasswordOpen(true)
      }}
    >
      {m.accountChangePassword}
    </button>
    <button
      type="button"
      onClick={() => {
        setOpen(false)
        logout()
      }}
    >
      {m.accountLogOut}
    </button>
  </div>
)}
{passwordOpen && (
  <Dialog
    title={m.accountChangePassword}
    onClose={() => setPasswordOpen(false)}
    returnFocusTo={badgeRef}
    className="account-password-dialog"
  >
    <PasswordForm email={user.email} onCancel={() => setPasswordOpen(false)} />
  </Dialog>
)}
```

The document-level Escape listener stays but now serves only the popover; trim its password-form comment accordingly (the dialog handles its own Escape and focus restore via `returnFocusTo`). `PasswordForm` itself is untouched — every guard (`sessionGeneration` captures, silent re-login, `expireSession()` fallback, `pending`, alert/status roles, `autoFocus`) stays exactly as is.

**`passwordOpen` must not survive the account it belongs to.** The component stays mounted across logout/expiry (it renders `null` on `!user` — the existing test at ~line 382 documents this hazard for `open`). A 401 mid-change runs `expireSession()` while `passwordOpen` is `true`; without a reset, the dialog springs open unprompted at the next login. Add above the `if (!user) return null` line:

```tsx
  // The dialog belongs to the session that opened it: the component stays
  // mounted across logout/expiry (rendering null), so a password dialog
  // left open by a mid-change 401 would otherwise reappear on re-login.
  useEffect(() => {
    if (!user) setPasswordOpen(false)
  }, [user])
```

- [ ] **Step 2: CSS**

Rename the `.account-password-panel` rules (~1977-2016) to `.account-password-dialog`, dropping popover-specific positioning (it inherits panel look from `dialog.app-dialog`); keep the form layout, `.login-field` sizing, and message rules; add `width: 300px`. `.account-password-actions/-cancel/-submit` rules stay as-is.

- [ ] **Step 3: Adapt the tests**

In `AccountMenu.test.tsx`, the password-flow tests reach the form by clicking "Change password" inside the popover — that path still works, and the completion-guard tests (session turnover, wrong password, success notice) keep their logic with container queries moved to `document.querySelector('dialog')`. **Three tests change semantics, not just queries:**

- ~L418 "an outside click dismisses the popover…": a modal is intentionally NOT outside-click dismissible (the page is inert). Reframe it: an outside `mousedown` leaves the dialog open; dismissal is `fireEvent.mouseDown(dialog)` (backdrop lands on the element itself).
- ~L432 "Escape dismisses the popover…" and ~L445 "Escape returns focus to the badge": both drive `u.keyboard('{Escape}')`, which reached the popover's document-level listener — that listener is now gated on `open === false` while the dialog is up, and happy-dom does not synthesize `cancel` from Escape. Rewrite both to fire the native event the browser would send: `fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }))`.

Add three guards:

```tsx
it('opens the password form in a modal dialog and closes the popover', () => { /* click badge, click change password; expect dialog open, expect .account-menu gone */ })

it('returns focus to the badge when the password dialog closes', () => { /* open dialog, fire cancel event on it; expect document.activeElement to be the badge button */ })

it('closes the password dialog on session turnover', () => { /* open dialog, set store user to null (mirror the ~L382 turnover test); expect document.querySelector('dialog') to be null; log back in — no dialog reappears */ })
```

- [ ] **Step 3b: Mutation-verify the turnover guard**

Delete the `if (!user) setPasswordOpen(false)` effect → the session-turnover test fails. Restore.

- [ ] **Step 4: Run tests, gates; mutation-verify**

Run: `npm test -- --run src/auth/AccountMenu.test.tsx`, then full gates. Expected: PASS.
Mutation: drop `returnFocusTo={badgeRef}` → the focus-return test fails (focus falls to the unmounted-opener fallback, i.e. body). Restore.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/auth/AccountMenu.tsx frontend/src/auth/AccountMenu.test.tsx frontend/src/App.css
git commit -m "feat(auth): change-password form in an accessible modal dialog (B3, #36)"
```

---

### Task 6: Admin own-row reset disabled + hint

**Files:**
- Modify: `frontend/src/admin/AdminView.tsx` (UserRow, the `admin-reset` cell, lines ~313-327)
- Modify: `frontend/src/i18n/messages.ts` + all 7 catalogs (`adminSelfResetHint`)
- Test: `frontend/src/admin/AdminView.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of the dialog work).
- Produces: i18n key `adminSelfResetHint: string`.

- [ ] **Step 1: Write the failing test**

Self-detection is by **id**, not email (`AdminView.tsx` renders `isSelf={user.id === me?.id}`), and the file's fixtures (`user()`, `adminUser()`) both default to `id: 1, email: 'ada@example.com'`. Seed the list with the self fixture plus a second user:

```tsx
it('disables the password reset on the own row with a hint', async () => {
  // store user (me) = the id-1 admin fixture, per the file's existing setup;
  // user list: self + one other row
  vi.mocked(getAdminUsers).mockResolvedValue([
    adminUser(),
    adminUser({ id: 2, email: 'bea@example.com' }),
  ])
  // render AdminView and await the list (file's existing pattern)
  const input = await screen.findByLabelText(`${en.adminResetPassword}: ada@example.com`)
  expect(input).toHaveProperty('disabled', true)
  expect(input.getAttribute('title')).toBe(en.adminSelfResetHint)
  const button = input
    .closest('td')!
    .querySelector('button') as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('title')).toBe(en.adminSelfResetHint)
  // the other row stays enabled
  const other = screen.getByLabelText(`${en.adminResetPassword}: bea@example.com`)
  expect(other).toHaveProperty('disabled', false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --run src/admin/AdminView.test.tsx`
Expected: FAIL — `disabled` is `false`, no title.

- [ ] **Step 3: Add the key and implement**

`messages.ts` (next to `adminGrantDisabledHint: string`, ~line 60): `adminSelfResetHint: string`.

| Catalog | `adminSelfResetHint` |
| --- | --- |
| en.ts | `'Use the account menu to change your own password.'` |
| de.ts | `'Das eigene Passwort wird über das Kontomenü geändert.'` |
| es.ts | `'La contraseña propia se cambia desde el menú de la cuenta.'` |
| fr.ts | `'Le mot de passe personnel se modifie via le menu du compte.'` |
| it.ts | `"La propria password si modifica dal menu dell'account."` |
| ja.ts | `'自分のパスワードはアカウントメニューから変更します。'` |
| zh.ts | `'自己的密码请通过账户菜单修改。'` |

(Each catalog's `accountMenu` translation is the authority for how "account menu" is rendered — align the noun with it.)

`AdminView.tsx`, the reset cell:

```tsx
<td className="admin-reset">
  <input
    type="password"
    value={newPassword}
    placeholder={m.adminPassword}
    disabled={isSelf}
    title={isSelf ? m.adminSelfResetHint : undefined}
    aria-label={`${m.adminResetPassword}: ${user.email}`}
    onChange={(e) => setNewPassword(e.target.value)}
  />
  <button
    disabled={isSelf || !newPassword || resetPending}
    title={isSelf ? m.adminSelfResetHint : undefined}
    onClick={() => void resetPassword()}
  >
    {m.adminResetPassword}
  </button>
</td>
```

- [ ] **Step 4: Run tests, gates; mutation-verify**

Run: `npm test -- --run src/admin/AdminView.test.tsx`, then full gates. Expected: PASS (including the existing other-row reset test).
Mutation: change `disabled={isSelf}` on the input to `disabled={false}` → the new test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/admin/AdminView.tsx frontend/src/admin/AdminView.test.tsx frontend/src/i18n
git commit -m "feat(admin): disable own-row password reset, point at the account menu (B3, #36)"
```

---

### Task 7: Architecture docs

**Files:**
- Modify: `docs/frontend-architecture.md`

**Interfaces:** none.

- [ ] **Step 1: Document the pattern**

Add a "Dialogs (B3)" subsection where the M2 password-popover and FolderDefaults text lives, and update those passages:

- `ui/Dialog.tsx`: native `<dialog>`/`showModal()`; platform focus trap (inert page); `cancel` event → `preventDefault()` + `onClose` (React owns unmounting); backdrop **mousedown** on the element itself dismisses; body scroll lock with prior-value restore; focus restore to `returnFocusTo` else the mount-time active element; `aria-labelledby` wired to the rendered `<h2>`; styling via `dialog.app-dialog` + `::backdrop` (`.dialog-overlay` is gone).
- `ui/ConfirmDialog.tsx`: Cancel autofocused (destructive-safe), danger confirm, generic `dialogCancel`/`dialogConfirm` keys; adopted by both DocumentSidebar deletes (no `window.confirm` remains).
- Change-password: now a modal dialog off the account popover, `returnFocusTo` = badge; all M2 completion guards unchanged (update the section that describes the drill-in `view` state).
- Admin: own-row reset disabled with `adminSelfResetHint`; the M6 abrupt-self-logout note is resolved (revocation semantics unchanged).

Accuracy rule: describe only behavior that exists in the merged code; verify each claim against the files before writing it.

- [ ] **Step 2: Gates + commit**

Run the full gates (docs don't affect them, but the commit rule holds).

```bash
git add docs/frontend-architecture.md
git commit -m "docs(frontend): B3 dialog pattern, password dialog, admin self-reset (B3, #36)"
```
