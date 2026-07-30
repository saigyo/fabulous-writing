# B3: Accessible Dialog Pattern — Design

**Issue:** #36 (B3). **Scope decisions (owner, 2026-07-30):** own-row admin
reset is *disabled* (not warn-and-proceed); the pattern also replaces both
`window.confirm()` calls; built on the native `<dialog>` element.

## Problem

The app has one modal (`FolderDefaultsDialog`) rendered on a bare
`.dialog-overlay` scrim with backdrop-click dismissal only — no focus trap,
no Escape handling, no scroll lock, no `role`/`aria-modal`, no focus
restore. The change-password form lives as a drill-in view inside the
account popover (three fields in a cramped panel). The admin view's own-row
password reset works but silently revokes the admin's own token (M2
revocation rule), so the next request 401s to the login gate with no
warning. Folder and document deletion use native `window.confirm()`.

## Design

### 1. `Dialog` — reusable primitive (`frontend/src/ui/Dialog.tsx`, new)

A modal wrapper around the native `<dialog>` element.

```tsx
export function Dialog({
  title,
  onClose,
  returnFocusTo,
  className,
  children,
}: {
  title: string
  onClose: () => void
  returnFocusTo?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
})
```

- **Open/close lifecycle:** `showModal()` in a mount effect; the cleanup
  closes the element, restores focus, and unlocks scroll. The dialog is
  mounted/unmounted by its parent (React-controlled); the component never
  closes itself except by calling `onClose`.
- **Focus trap:** free from the platform — `showModal()` makes the rest of
  the page inert. No hand-rolled Tab cycling.
- **Escape:** the native `cancel` event. Handler calls `preventDefault()`
  (the element must not close itself out from under React) and `onClose()`.
- **Backdrop dismissal:** `mousedown` on the `<dialog>` element itself
  (`event.target === dialogRef.current`) **with pointer coordinates outside
  the element's `getBoundingClientRect()`** — native backdrop clicks land
  on the element, but so do clicks on the panel's own padding, which must
  not dismiss (they don't today: the panel is a child of the overlay).
  `mousedown` (not `click`) matches the current FolderDefaults behavior: a
  drag that starts inside and releases outside must not dismiss.
- **Scroll lock:** `document.body.style.overflow = 'hidden'` while open,
  restored to its prior value on cleanup.
- **Focus restore:** on cleanup, focus `returnFocusTo.current` if provided,
  else the element that was `document.activeElement` at mount (captured
  before `showModal()` moves focus). The explicit prop exists because the
  opener can be unmounted by the time the dialog opens (a popover menu item)
  — callers then name a stable target (e.g. the account badge). Explicit
  restore is also deterministic in happy-dom, where native restore is not
  guaranteed.
- **Initial focus:** the platform rule (first `autofocus` element, else the
  dialog). Forms keep using React's `autoFocus`.
- **Labeling:** `title` renders as `<h2 id={useId()}>`; the `<dialog>` gets
  `aria-labelledby` pointing at it. No `aria-modal`/`role` attributes —
  native semantics.
- **Styling:** shared `dialog` element styles + `dialog::backdrop` replace
  `.dialog-overlay` (which is deleted). The panel look (background, border,
  radius, padding) moves onto the `dialog` element itself; per-dialog width
  via `className`.

### 2. `ConfirmDialog` (`frontend/src/ui/ConfirmDialog.tsx`, new)

```tsx
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  returnFocusTo,
}: { ... })
```

Built on `Dialog` (`onClose = onCancel`; `returnFocusTo` forwarded — the
delete menus unmount before the dialog opens, so callers pass the
persistent menu-toggle button's ref or focus would fall back to `<body>`
on close). Message paragraph + two buttons:
Cancel (autofocus — destructive-safe default) and a danger-styled confirm.
New i18n keys `dialogCancel` and `dialogConfirm` (generic labels, all 7
locales); `confirmLabel` overrides `dialogConfirm` where a more specific
verb exists — both delete confirms below use the generic default (no
override). Escape and backdrop both cancel.

**Adoption:** `DocumentSidebar`'s two `window.confirm()` calls (folder
delete `m.folderDeleteConfirm(name)`, document delete
`m.docDeleteConfirm(name)`) become `ConfirmDialog`s driven by a
`pendingDelete` state holding the target; confirm runs the existing delete
path, cancel just clears the state. No native browser dialogs remain.

### 3. `FolderDefaultsDialog` migration

The outer `div.dialog-overlay` + inner `div.folder-defaults-dialog` become
`<Dialog title={m.folderDefaults + ': ' + folder.name} onClose={onClose}
className="folder-defaults-dialog">`. The existing `<h2>` is replaced by
the Dialog-rendered title. Field markup, draft logic, and save/cancel
behavior unchanged.

### 4. Change-password form onto a dialog

`AccountMenu` loses its `view` drill-in state: the popover is a plain menu
(email, "Change password", "Log out"). "Change password" closes the popover
and sets `passwordOpen`; that renders
`<Dialog title={m.accountChangePassword} onClose={...}
returnFocusTo={badgeRef}>` containing `PasswordForm` — moved intact:
session-generation guards, silent re-login, `expireSession()` fallback,
alert/status roles, autoFocus on the current-password field, pending guard.
The popover's document-level Escape listener shrinks back to menu-only
duty; the dialog handles its own Escape and focus restore. Success behavior
unchanged: the notice renders inside the dialog; the user closes it.

### 5. Admin own-row reset: replaced by a hint

In `AdminView`'s `UserRow`, when `isSelf` the reset cell renders the hint
text (new key `adminSelfResetHint` ≈ "Use the account menu to change your
own password.", all 7 locales) **instead of** the input and button. Visible
text rather than disabled controls with a `title`: disabled elements are
unfocusable, so a tooltip-only hint would be undiscoverable for keyboard
and screen-reader users. The abrupt self-logout path becomes unreachable
from the admin table; server-side revocation semantics are untouched and
other rows are unaffected.

## Error handling

Nothing new: dialogs host existing forms whose error paths (banner, field
messages, session guards) move unchanged. `ConfirmDialog` has no failure
mode of its own — the delete paths keep their current error handling.

## Testing

happy-dom 20 implements `HTMLDialogElement` (`show`/`showModal`/`close`,
`open`); the `cancel` event is dispatched manually in tests (happy-dom does
not synthesize it from Escape keydown).

- **Dialog unit tests** (`src/ui/Dialog.test.tsx`): mounts open the native
  dialog (`open` attribute / `showModal` spy); `cancel` event → `onClose`
  called and default prevented; `mousedown` on the dialog element → dismiss,
  on an inner element → no dismiss; body scroll locked while mounted and
  restored after; focus restored to `returnFocusTo` (and to the captured
  active element when the prop is absent).
- **ConfirmDialog tests:** Cancel holds initial focus; confirm/cancel
  callbacks; Escape cancels.
- **Migrated surfaces:** FolderDefaults tests keep passing on the new
  shell; AccountMenu tests move password-flow assertions onto the dialog
  (incl. focus returning to the badge — the popover's outside-click and
  Escape dismissal tests are reframed for modal semantics); DocumentSidebar
  gains a component-test harness (today it holds only pure-helper tests;
  nothing renders `<DocumentSidebar>` yet) covering both delete confirms;
  AdminView gains a self-row test (hint text rendered, no reset controls)
  and keeps the other-row reset test.
- Every new guard test is mutation-verified (delete the guard, watch the
  test fail, restore).
- Gates: `npm test -- --run` green, `npm run build` clean. Backend
  untouched.

## Out of scope

Warn-and-proceed own-row reset (rejected), informal UI register (B2),
generic toast/notification work, and any backend change.
