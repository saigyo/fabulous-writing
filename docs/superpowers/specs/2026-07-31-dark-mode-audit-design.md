# Dark-Mode Audit (B18, #63) — Design

**Item:** [B18 #63](https://github.com/saigyo/fabulous-writing/issues/63). In dark
mode most, but not all, labels and UI elements follow the theme. Owner
screenshots (2026-07-31) show four symptom sites; design-phase diagnosis
(code reading plus an instrumented harness session) reduced them to four
root-cause classes, three of them empirically confirmed.

**Scope decision (settled with Markus, 2026-07-31):** OS-follow only — dark
mode remains driven by `prefers-color-scheme` exactly as today. No manual
theme toggle (a future item may add one; the token discipline this fix
enforces is what a toggle would need anyway). No redesigns: light mode must
come out of this visually unchanged except where explicitly listed.

## Diagnosis (evidence, not theory)

1. **No `color-scheme` declaration.** `getComputedStyle(root).colorScheme`
   is `"normal"` in the running app. The UA therefore renders form-control
   internals in its default light scheme regardless of the app's tokens:
   the profiles view's `<select multiple>` listboxes and both textareas
   render as light boxes, password inputs keep dark-on-dark key icons, and
   scrollbars stay light.
2. **Buttons without `color` fall back to UA `ButtonText`.** Confirmed via
   computed style in the harness: `.account-menu > button` computes
   `color: rgb(0, 0, 0)` on a correctly dark `rgb(23, 23, 27)` menu — the
   unreadable doc-menu/account-menu items and dialog Cancel buttons.
3. **`--bg-raised` is referenced but never defined** — `.rules-count`
   (`var(--bg-raised, #eee)`) and `.rule-pattern pre`
   (`var(--bg-raised, #f6f6f6)`) always get their light fallbacks, in both
   themes.
4. **Hard-coded light chrome**: e.g. `.tier-option { background: #fff;
   border: 1px solid #d8d8e0 }` (the white chips). `App.css` contains ~63
   hex-literal occurrences to classify (most are legitimate semantic
   colors; see the sweep).

**The white account-menu mystery — leading hypothesis, arbiter named.**
The owner's screenshot and one full-page harness render both show the
account-menu popover with a *white* background, yet its computed
`background-color` is the correct dark value, `elementsFromPoint` at its
center finds no white-painting layer, and an element-level screenshot of
the same open menu renders dark. This is consistent with the popover's
promoted compositing layer (position: absolute, z-index 20, overlapping
the sticky sidebar header) being composited against the UA's default
canvas, which is white while `color-scheme` is `normal`. The fix-1
declaration is expected to cure it. **The harness is the arbiter:** the
verification matrix includes the open account menu in dark mode; if the
white rendering survives fix 1, that becomes a dedicated diagnosis loop in
the implementation — it must not be hand-waved or closed on hypothesis.

## The three fixes (plus the sweep)

**Amendment (owner decision, 2026-07-31, from plan review):** the originally
specified fix 2 — a global `button { color: inherit }` reset — is DROPPED.
UA system colors resolve against the *used* `color-scheme` (CSS Color
Adjust): once fix 1 declares `color-scheme: dark`, `ButtonText` resolves to
a light color by itself, curing every diagnosed button symptom with zero
light-mode delta. The reset would have (a) shifted every colorless button
`#000`→`#1c1c1f` in light mode, breaking the pixel-identity gate on ~8
pairs; (b) overridden the UA's disabled-button greying by cascade origin
(author beats UA regardless of specificity), visibly degrading the admin
create/reset buttons and not-on-plan tier chips in both themes; (c) turned
the terminology Add button dim-grey in light mode via its table's
`--text-dim`. The dark screenshot matrix now carries the burden of proof
that ButtonText-dependent buttons are readable in dark mode.

### 1. `color-scheme` (frontend/src/index.css)

- `:root { color-scheme: light; ... }` alongside the existing light
  tokens; `color-scheme: dark` inside the existing
  `@media (prefers-color-scheme: dark)` block alongside the dark tokens.
- No `data-theme` layer, no toggle plumbing (scope decision above).

### 2. (dropped — see the amendment above)

Button readability in dark mode is delivered by fix 1's `color-scheme`
(ButtonText follows the scheme) and verified empirically by the dark
screenshot matrix (doc menu, account menu, dialog Cancels, chips). No
author-level button color reset lands.

### 3. Define `--bg-raised` (frontend/src/index.css)

- Light: `--bg-raised: #eee`. Dark: a `--panel`-family raised value
  (plan pins the exact hex; visibly raised against `--panel #1e1e24`,
  e.g. the `#26262e` neighborhood).
- Both use sites drop their fallbacks (`var(--bg-raised)`).
- **Known, intended light-mode micro-diff:** `.rule-pattern pre` shifts
  `#f6f6f6` → `#eee` (one token, one value). This is the only permitted
  light-mode change outside pure UA-chrome rendering; it appears in the
  verification contract as an intended diff.

### 4. Hex-literal sweep (frontend/src/App.css)

Every hex color in `App.css` (~63 occurrences) is classified into exactly
one of:

- **(a) semantic — keep:** (one recorded exception inside this class: the
  held-back amber text `#b45309` measures **3.30:1** on dark `--panel` —
  fails WCAG AA; it stays KEEP in this item, and a follow-up contrast
  ticket is filed during implementation rather than fixed as a drive-by.)
  Otherwise: colors that mean something in both themes:
  the danger/error red family (`#e5484d`), the WCAG-picked filled danger
  `#c22126`, white text on accent/danger fills (`#fff` as `color`),
  severity/category colors (e.g. `#e93d82`), and any others the sweep
  justifies in place.
- **(b) light-chrome — tokenize:** backgrounds/borders that encode "light
  surface" and must follow the theme: `.tier-option`'s `background: #fff`
  → `var(--bg)` and `border-color #d8d8e0` → `var(--border)`; the admin
  table's `border-bottom: 1px solid #ddd` → `var(--border)`; plus whatever
  else the grep finds. In light mode the replacement token must resolve to
  the same or imperceptibly-close value — the light screenshot gate
  enforces this.
- **(c) shadows/overlays — keep:** `rgba(0,0,0,…)` box-shadows and the
  dialog backdrop are theme-agnostic by design; listed, not changed.

The classification table lives in the plan (every occurrence, file:line,
verdict, replacement) — no occurrence may be silently skipped.

## Out of scope

- Manual theme toggle; any new tokens beyond `--bg-raised`; visual
  redesigns of chips/menus/forms (they keep their shape, gaining only
  correct theme colors); editor content/finding-underline colors (CodeMirror
  theme — none of the reported symptoms touch it; if the sweep finds
  dark-mode defects there, they are ticketed separately, not fixed here);
  backend; copy.

## Verification

- Frontend gates: `npm test -- --run` green, `npm run build` clean. No new
  unit tests — CSS-only change; the screenshot matrix is the verification.
- **Both-themes screenshot matrix**, extending the B11+B4 harness
  (scratch stack :8001/:4199, driver re-run unchanged between before and
  after): every signed-in surface from the existing shot list (editor,
  rules, terminology, profiles, admin, account-menu, doc-menu,
  folder-defaults, confirm-dialog) captured in BOTH themes, plus the
  password-change dialog (a symptom site not yet in the list) in both
  themes, plus the existing 4 gate shots — ~24 shots per side,
  before/after.
- **Comparison contract:** light-mode pairs are pixel-identical
  (`cmp -s`) except (i) UA scrollbar/chrome rendering differences caused
  by the `color-scheme` declaration where the UA chooses to render
  differently even in light (expected: none, but classified if seen) and
  (ii) the single `.rule-pattern pre` `#f6f6f6`→`#eee` micro-diff.
  Dark-mode pairs must show: readable menu items (doc menu, account
  menu), dark form-control chrome in profiles (listboxes, textareas) and
  the password dialog, themed chips (`.tier-option`, rule packs,
  `.rules-count`), and the account-menu popover rendering dark in the
  full-page composite (the hypothesis arbiter). Any unexplained diff:
  STOP, report.
- WCAG: any newly chosen dark values for chips/badges keep text at
  ≥ 4.5:1 (the B3 precedent); the plan lists the contrast checks for the
  values it pins.

## Sequencing

Current UI-polish wave, while the B11+B4 harness is fresh (its scripts
are reused nearly verbatim). Before B12 (#53). Own planning PR then
implementation PR, per convention.
