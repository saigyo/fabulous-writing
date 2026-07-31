# Dark-Mode Follow-ups (#65 amber contrast, #66 CodeMirror) — Design

**Items:** [#65](https://github.com/saigyo/fabulous-writing/issues/65) and
[#66](https://github.com/saigyo/fabulous-writing/issues/66), both filed
during B18 (#63) as explicitly-parked follow-ups. One combined item: one
planning PR (this spec + plan), one implementation PR closing both.

**Scope decisions (settled with Markus, 2026-07-31):**

- #66 covers editor **chrome plus markdown formatting-mark colors** — the
  design-phase audit found that `basicSetup`'s static highlight style
  paints markdown marks in fixed light-mode colors the dark facet never
  touches, so a chrome-only fix would knowingly ship a still-partial dark
  editor.
- Theme handling stays OS-follow only (B18's standing decision); the
  editor must follow a mid-session OS theme change live, like every other
  surface.
- Light mode is **byte-identical** across the whole verification matrix —
  unlike B18, this item declares no intended light-mode diffs.

## Diagnosis

### #65 — held-back amber

Exactly two declarations carry the failing color, both in `App.css`:
`.suggestion-button.held-back:hover { color: #b45309 }` (line ~731) and
`.held-back-reason { color: #b45309 }` (line ~738). `#b45309` measures
**3.30:1** on dark `--panel` (`#1e1e24`) — below WCAG AA 4.5:1.

The neighboring amber family is fine and stays: the `#d97706` dashed
border computes ~5.2:1 on dark `--panel` (above even the 4.5:1 text
threshold, far above the 3:1 non-text requirement), and the
`rgba(217, 119, 6, …)` washes are backgrounds, not text.

### #66 — CodeMirror ignores dark mode

`frontend/src/editor/Editor.tsx` mounts `basicSetup` with no theme, so
CM6's `EditorView.darkTheme` facet stays `false` and the base-light
chrome wins regardless of the app's `color-scheme`: light gutter
(`.cm-gutters` `#f5f5f5`, `.cm-activeLineGutter` `#e2f2ff`), black caret,
and the `#d7d4f0` focused-selection layer — all near-invisible on the
dark canvas.

CM ships a complete built-in dark base theme behind that facet (caret
`#ddd`, focused selection `#233`, gutters `#333338`/`#ccc`, dark active
line, panels, tooltips) — flipping the facet cures all reported chrome
symptoms in one move.

Beyond the ticket's chrome list: `basicSetup`'s
`defaultHighlightStyle` assigns fixed light-mode colors that the facet
does **not** switch. For markdown these are the formatting marks (`#`,
`**`, `>`, list and link marks — all `tags.processingInstruction`, which
falls back to its parent `tags.meta`, `#404740` dark grey) and
URLs/thematic breaks (`tags.url` / `tags.contentSeparator`, `#219`
navy) — both unreadable on `#17171b`. CM selects highlight styles by the
same facet when they declare `themeType`, so a small dark-variant
`HighlightStyle` covers them without touching light mode.

## The fixes

### 1. `--held-back` token (#65)

- `frontend/src/index.css`: new token beside `--bg-raised`, with a short
  comment noting the AA rationale —
  light `--held-back: #b45309` (today's value, light mode unchanged),
  dark `--held-back: #f59e0b`.
- Contrast for the dark value: **7.7:1** on `--panel`, **6.3:1** on the
  hover state's composite background (`rgba(217,119,6,0.15)` over
  `--panel`) — both clear AA.
- `App.css`: the two declarations become `color: var(--held-back)`.
  Nothing else in the amber family changes.

### 2. Editor dark theme (#66)

New file `frontend/src/editor/theme.ts`, integrated into `Editor.tsx`'s
extension list (one added line) plus a listener hookup/cleanup in the
existing mount effect. Shape:

- **A `Compartment`** whose content is `[]` in light mode and, in dark
  mode, the pair `[darkChrome, darkMarkdownColors]`:
  - `darkChrome = EditorView.theme({...}, { dark: true })` — the
    `dark: true` flag flips the facet, activating CM's built-in dark
    chrome. The theme body token-aligns only the gutter family to app
    tokens (`.cm-gutters`: background `var(--panel)`, color
    `var(--text-dim)`; `.cm-activeLineGutter`: background
    `var(--bg-raised)`). No gutter border is declared: CM's dark base
    draws none (border width/style exist only under its `&light` rules),
    so a color alone would be dead config. Caret, selection, and active
    line stay on CM's proven base-dark values — no custom overrides.
  - `darkMarkdownColors = syntaxHighlighting(HighlightStyle.define(...,
    { themeType: 'dark' }))`. **Replacement semantics (plan-review
    correction, 2026-07-31):** `basicSetup` registers
    `defaultHighlightStyle` as a *fallback* highlighter, and any main
    highlighter — which a `themeType: 'dark'` style is while the facet
    is on — replaces the fallback wholesale rather than layering on it.
    A two-rule dark style would therefore silently drop every default
    decoration (heading bold+underline, strong, emphasis, link
    underline) in dark mode. The dark style is instead built from
    `defaultHighlightStyle.specs` (public API) with exactly two color
    substitutions, matched by tag identity: the `tags.meta` entry
    (`#404740` — markdown formatting marks via `processingInstruction`'s
    tag-parent fallback) → `var(--text-dim)` (6.7:1 on `--bg`), and the
    array entry carrying `tags.url`/`tags.contentSeparator` (`#219` —
    link destinations, thematic breaks; the entry also carries
    `atom`/`bool`/`labelName`, none produced by markdown) →
    `var(--accent)` (5.7:1 on `--bg`). All other specs pass through verbatim, so every non-color
    decoration survives identically. `HighlightStyle` compiles to CSS
    classes, so `var()` values are legal.
- **Live follow:** the compartment initializes from
  `matchMedia('(prefers-color-scheme: dark)')` at view creation; a
  `change` listener dispatches a compartment reconfigure. Exported
  interface: an `Extension` for the extensions array plus a
  `watchTheme(view): () => void` that registers the listener and returns
  its cleanup; `Editor.tsx` calls the cleanup in the effect's teardown
  before `view.destroy()`.
- Light mode contributes **zero style rules** (empty compartment), which
  is what makes the no-exceptions byte-identity gate possible.
- **Dependencies:** `HighlightStyle`/`syntaxHighlighting` come from
  `@codemirror/language` and `tags` from `@lezer/highlight` — today only
  transitive dependencies. Both are added to `package.json` as direct
  dependencies (at the versions already resolved in the lockfile);
  `Compartment` comes from `@codemirror/state`, already direct.

## Out of scope

- Manual theme toggle (unchanged B18 decision).
- Any other CM restyling: light-editor pixels stay identical; no custom
  caret/selection/active-line values in dark; no content-color redesign
  beyond the two dark tag rules above.
- The `#d97706` border and `rgba` amber washes (measured fine).
- Backend; copy; other surfaces (B18 closed them).

## Verification

- Frontend gates: `npm test -- --run` green, `npm run build` clean.
- **Both-themes screenshot matrix**, reusing the B18 harness
  (scratch stack :8001/:4199, `b18-screens/shoot-themes.mjs` driver
  re-run unchanged between before and after), with two additions:
  - an editor shot with markdown-rich content (heading, bold, `---`, a
    `[text](url)` link — deliberately link-form: `markdown()` is
    CommonMark without GFM, so bare URLs are never tagged `tags.url`)
    plus an active text selection and focused caret, both themes. The
    editor shots are element-scoped to `.editor-area`: the document
    sidebar's minute-granular time label would otherwise race the
    byte-identity gate on wall-clock drift between runs;
  - a live-flip check: `page.emulateMedia({ colorScheme })` toggled
    mid-session must switch the editor chrome without a reload.
- **Comparison contract:** light-mode pairs are pixel-identical
  (`cmp -s`) across the whole matrix, **no declared exceptions**.
  Dark editor pairs must show: dark gutter in the `--panel` family,
  visible caret, visible selection, readable markdown marks and link
  URL, **and surviving default decorations** — the heading still
  bold+underlined, `**bold**` still bold (the guard against the
  replacement-semantics trap above). Any unexplained diff: STOP, report.
- **#65 verification:** held-back suggestions are produced only by the
  LLM suggestion-vetting path (`held_back` in the suggest response), so
  the keyless scratch stack cannot reach them organically. Verify by
  computed-style probe (inject the two classes into the live page, read
  resolved `color` per theme) plus the contrast math above. No pixel
  shot required; the light probe must resolve to `#b45309` exactly.
- No new unit tests expected — CSS token swap plus theme wiring; the
  matrix and probes are the verification. If the plan finds a testable
  seam (e.g. `watchTheme` cleanup), a test there is welcome but not
  required.

## Sequencing

Immediately after B18 (#63, shipped as PR #67), while the harness is
fresh. Before B2 (#35) and B9 (#42). Own planning PR (this spec + plan,
squash-merged) then implementation PR closing both issues — with
separate closing keywords (`Closes #65. Closes #66.`), per the
one-ref-per-keyword lesson from PR #62.
