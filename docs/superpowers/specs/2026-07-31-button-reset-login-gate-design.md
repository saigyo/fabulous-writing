# Button Font Consolidation (B11, #52) + Split Login Gate (B4, #37) — Design

One branch, one PR, closes both issues. Combined because both re-touch many
surfaces and B11's verification sweep covers B4's new gate for free.

**Corrected premise (supersedes #52's text; the issue gets rewritten):**
#52 claimed the app has no global button reset. It does — `input, select,
button { font: inherit }` has lived in `App.css` (currently lines
1059–1063) since the first frontend commit (2026-07-03, `d7a6f56`), it is
top-level, and it loads before the login gate renders (`main.tsx`
statically imports `App.tsx`, whose CSS side-effect fires at module
evaluation). The B3-era symptom ("larger and off-family" menu buttons) was
a **font-size** bug: unsized buttons inherit the root 1rem inside 0.85rem
surfaces. Commit `b9afdfe` fixed the size correctly but also added two
redundant `font: inherit` lines with comments asserting the reset doesn't
exist. B11 is therefore consolidation plus a size sweep — not a new reset.

**Settled with Markus, 2026-07-31:** B11 scope = cleanup + size sweep;
B4 layout = split pane (option A of three mockups); tagline copy (EN):
*"Write clearly. Get checked, not judged."*

## B11 — reset consolidation + button size sweep

### Consolidation

- Move `input, select, button { font: inherit }` from `App.css` to
  `frontend/src/index.css`, placed with the `* { box-sizing: border-box }`
  reset — global resets live in the file that loads first, independent of
  App.css's import timing. Delete the App.css copy.
- Delete the three dead `font: inherit` declarations that duplicate the
  global rule: `.doc-menu button` (~1698), `.account-menu > button`
  (~2026), `.rules-collapse` (~1135; its `color`/`letter-spacing`/
  `text-transform: inherit` lines stay — the global reset does not cover
  them). The neighboring `font-size: 0.85rem` lines are real design
  choices and stay.
- Rewrite the two false comments ("No global button reset exists…" and
  its copied twin) to state the actual mechanism: the global reset makes
  buttons inherit; these rules pin the *size* for their surface. The
  `.doc-menu-delete` color note (danger red must keep winning) remains
  true and stays.

### Size sweep

**Rule:** no `<button>` may silently inherit the root 1rem inside a
surface whose text is smaller. Every button either inherits a correct
ancestor size or declares its surface's established size.

Candidates audited (plan phase, by reading each candidate's ancestor
chain and sibling rules — `font: inherit` inherits from the *parent*, so
a candidate only violates the rule when its ancestors are unsized while
its visual siblings are smaller):

- **ConfirmDialog Cancel + danger confirm — the one true violation.**
  Ancestors (`.confirm-dialog-buttons` → `dialog.app-dialog`) set no
  size → both buttons render 1rem beside the dialog's 0.85rem body text
  (`.confirm-dialog p`). Fix: `.confirm-dialog-buttons button
  { font-size: 0.85rem; }` — sets no `color`, so
  `.confirm-dialog-danger` keeps winning unchanged.
- Admin create-user/reset-password buttons: the admin view is a 1rem
  surface (table cells and inputs all inherit root); the buttons match
  their surface — **no change**.
- Terminology add-domain button: the domains aside is likewise an
  unsized 1rem surface — **no change**. Add-term button: sits inside
  `.term-table table` (0.85rem) and inherits it — **no change**.
- Doc-list retry button: inherits 0.78rem from its parent
  `p.doc-list-error` — **no change**.

The screenshot sweep still covers all audited surfaces to confirm the
measurements visually.

Explicitly *not* changed (deliberate sizes, verified during design):
`.view-switch button`, `.icon-button`, `.login-submit`, `.check-button` /
`.domain-multiselect-toggle` (inherit `.header-controls` 0.85rem),
`.doc-menu button` / `.account-menu > button` (0.85rem), and every button
listed in the inventory with an explicit font-size.

Class-less fix mechanics: give each violation a class scoped to its
surface (or extend an existing surface rule) — no new bare-element rules
beyond the single global reset.

### Specificity guard

The global reset is a bare element selector (0,0,1); every color/danger
override in the app lives on class selectors (≥ 0,1,0) or deliberately
omits `color` on element-level rules. No specificity change is permitted
as part of the sweep: `.doc-menu-delete`'s danger color and
`.confirm-dialog-danger` must render identically before and after.

## B4 — split login gate

### Shell

`LoginGate` renders one shell for **all** pre-auth states:

```
.login-gate                     (existing full-viewport flex wrapper)
└── .login-split
    ├── .login-brand            brand pane
    │   ├── Wordmark            (shared component, scaled up here)
    │   └── .login-tagline      new localized tagline
    └── .login-pane             form pane (centers its child)
        └── the existing card: LoginForm's sign-in card, or the
            connection-failed/retry card
```

The one change *inside* the cards: both currently open with `<Wordmark/>`,
which moves to the brand pane — the cards lose it and keep everything
else (fields, buttons, alerts) byte-identical.

Both the anonymous state (LoginForm) and the `restoreFailed` retry card
render inside `.login-pane`. The `authStatus === 'unknown'` state still
renders `null` (no flash before the token check resolves) and the
`authenticated` state still renders `children` — the four-state branching
in `LoginGate.tsx` is unchanged.

- Session-expired and submit-error notices stay inside the form card
  exactly as today (`role="alert"`, same precedence logic in
  `LoginForm.tsx`).
- All accessible roles and names are unchanged — existing gate tests pass
  untouched.
- The card's internals are untouched: `.login-field` is shared with the
  change-password dialog and must not change appearance there.
- The header's wordmark sizing (`.header .wordmark`) is untouched; the
  brand pane sets its own size via `.login-brand .wordmark` (the card's
  current `.login-card .wordmark` rule moves/retires with the wordmark's
  relocation out of the card into the brand pane — the card no longer
  contains the wordmark).

### Tagline & i18n

- New key `loginTagline` in all 7 catalogs. EN: `Write clearly. Get
  checked, not judged.` Translations in the **current impersonal
  register** (de/fr/es/it formal; the informal pass remains B2's scope).
  The catalog-parity test (`i18n.test.ts`) already enforces key
  completeness across all seven.
- No other new copy. The feature-strip idea (mockup option C) is out of
  scope.

### Theming & responsive

- Brand pane background: a wash built only from existing tokens
  (`--accent-soft` over `--panel`/`--bg`), so light and dark themes both
  work with no new color definitions.
- New breakpoint (the gate currently has none): below **720px** the panes
  stack — the brand pane becomes a compact wordmark + tagline header
  above the card, the split's side-by-side geometry applies at ≥ 720px.
  Exact paddings/gaps are plan-level detail.

### Out of scope

- No public/marketing landing page, no feature strip, no screenshots.
- No changes to auth logic, session handling, or the password dialog.
- No informal-register copy (B2).

## Housekeeping (this branch)

- Rewrite issue #52 to the corrected diagnosis (reset exists; size was
  the bug; link this spec).
- Add `.superpowers/` to `.gitignore` (SDD/brainstorm scratch is
  currently untracked-but-visible).

## Verification

- Frontend gates: `npm test -- --run` green, `npm run build` clean.
- New test: the anonymous gate renders the tagline (by translated text,
  via the existing `en` catalog import pattern); gate state branching is
  already covered and must stay green.
- **Screenshot sweep** (headless-e2e recipe from the scratch notes):
  before/after captures of every surface #52 names — header, document
  sidebar, findings sidebar, editor, admin view, rules / terminology /
  profiles views, folder-defaults + confirm dialogs, account menu, login
  gate (both split ≥ 720px and stacked < 720px, light and dark) — diffed
  by eye for unintended size shifts. The four sweep fixes are *intended*
  shifts; everything else must be pixel-stable modulo them.
- CSS-only changes carry no unit tests; the sweep is the verification.

## Sequencing

Own branch + PR (planning docs first, then implementation on a follow-up
branch per the repo convention). After B1 (#34, merged). Before B2 (#35)
— the tagline lands impersonal and B2 sweeps it with everything else.
