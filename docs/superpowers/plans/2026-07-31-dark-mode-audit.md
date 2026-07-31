# Dark-Mode Audit (B18, #63) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every surface follow the dark theme via three mechanism fixes (`color-scheme`, defined `--bg-raised`, classified hex sweep), verified by a both-themes before/after screenshot matrix.

**Architecture:** CSS-only. Systemic fixes land in `index.css` (theme root); the sweep edits `App.css` per a complete classification table (this plan carries every hex occurrence with a verdict — no silent skips). Verification is the extended B11+B4 Playwright harness shooting ~24 surfaces per side in both themes.

**Tech Stack:** CSS custom properties + `prefers-color-scheme` (OS-follow only — no toggle); playwright-core harness against the scratch stack (:8001 backend / :4199 preview).

**Spec:** `docs/superpowers/specs/2026-07-31-dark-mode-audit-design.md` — binding.

## Global Constraints

- Frontend gates before every commit: `npm test -- --run` green and `npm run build` clean, from `frontend/`.
- NEVER touch ports **5173/8000** or `backend/data/fabulous.db`. The harness uses **:8001/:4199** with a tempfile DB; kill only own PIDs; plain `npm run build` afterwards restores production `dist/`.
- Light mode stays visually identical EXCEPT the enumerated micro-diffs in Task 4's comparison contract. Dark-mode changes are the deliverable.
- No manual theme toggle, no `data-theme` layer, no new tokens beyond `--bg-raised`, no redesigns, no CodeMirror/editor-content color changes (defects found there are ticketed, not fixed).
- The white-account-menu hypothesis is settled by the harness (Task 4); if it survives fix 1, STOP and report — do not close on theory.
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

## File Structure

- Modify `frontend/src/index.css` — `color-scheme` in both theme blocks, `--bg-raised` in both. (No button color reset — see the spec's dropped-fix-2 amendment.)
- Modify `frontend/src/App.css` — two `--bg-raised` fallback drops + five tokenize edits (classification table below).
- Modify `docs/frontend-architecture.md` (Task 5).
- Harness artifacts (outside repo): `<scratchpad>/b18-screens/` where `<scratchpad>` = `/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad` — `server.py` (copied verbatim from `<scratchpad>/b11b4-screens/server.py`), new `shoot-themes.mjs`, `before/` and `after/` PNG sets, `COMPARISON.md`.

## The classification table (all 63 hex-bearing lines — 66 occurrences — in App.css)

Verdicts: **KEEP** (semantic, works in both themes), **TOKENIZE** (light-chrome → token), **BG-RAISED** (fix 3), **COMMENT** (not code). Line numbers from the planning snapshot (branch `b18-dark-mode-plan` @ 5f5197e) — locate by quoted text.

| Lines | What | Verdict |
|---|---|---|
| 320–326 | `.fw-finding.fw-*` underline colors (7: `#e5484d #f76b15 #8e4ec6 #0090ff #12a594 #ffb224 #e93d82`) | KEEP — category palette |
| 335–341 | `.category-dot.fw-*` backgrounds (same 7) | KEEP — category palette |
| 382, 528(`#f76b15`), 532, 537, 636–637, 690, 868, 1056, 1103, 1332, 1455, 1697, 1709, 1910, 2155 | error/warning text colors (`#e5484d`/`#f76b15`) on `.llm-error`, severity labels, crud/doc/profiles/admin errors, `.doc-menu-delete`, `.icon-button:hover` | KEEP — semantic danger/warning |
| 538 | `border: 1px solid #e5484d55` | KEEP — danger border w/ alpha |
| 726, 731, 738 | held-back amber: `border: 1px dashed #d97706`; `color: #b45309` ×2 | KEEP — semantic warning family; measured now: `#b45309` on dark `--panel` = **3.30:1**, fails AA. Stays KEEP here (no drive-by fixes); Task 5 files the follow-up contrast ticket |
| 745 | `.advice-note { color: #6b7280 }` | TOKENIZE → `var(--text-dim)` (light micro-shift `#6b7280`→`#6f6f78`, imperceptible; dark becomes readable `#9d9da8`) |
| 775–777 | `.score-high/mid/low` (`#12a594 #ffb224 #e5484d`) | KEEP — score palette |
| 1088 | `.rules-count { background: var(--bg-raised, #eee) }` | BG-RAISED — drop fallback |
| 1205–1207 | `.rule-badge.level-*` color+border pairs | KEEP — severity palette |
| 1229 | `.rule-pattern pre { background: var(--bg-raised, #f6f6f6) }` | BG-RAISED — drop fallback (declared light micro-diff `#f6f6f6`→`#eee`) |
| 1260–1261 | rule-example marks (`#e5484d` bad / `#2a9d63` good) | KEEP — semantic |
| 1285–1287 | `.severity-filter-button.severity-*` colors | KEEP — severity palette |
| 1512 | `.tier-option { border: 1px solid #d8d8e0 }` | TOKENIZE → `var(--border)` (light micro-shift `#d8d8e0`→`#e4e4e7`) |
| 1514 | `.tier-option { background: #fff }` | TOKENIZE → `var(--bg)` (light identical) |
| 1519–1521 | `.tier-option.selected { background/border #5b5bd6; color: #fff }` | KEEP — saturated selected fill with white text, theme-agnostic like the danger fill |
| 1531 | `.pinned-note { color: #667 }` | TOKENIZE → `var(--text-dim)` (light micro-shift `#666677`→`#6f6f78`) |
| 1775, 1778 | conflict borders (`#e5484d`): 1775 `.new-folder-input.conflict`, 1778 rename-input conflict | KEEP — danger |
| 1835 | comment text mentioning `#e5484d` | COMMENT — untouched |
| 1839–1841 | `.confirm-dialog-danger { #c22126 ×2; color: #fff }` | KEEP — WCAG-picked fill (B3) |
| 2015 | `.login-submit { color: #fff }` | KEEP — white on accent |
| 2143 | account-password submit `color: #fff` | KEEP — white on accent |
| 2154 | `.admin-users th, td { border-bottom: 1px solid #ddd }` | TOKENIZE → `var(--border)` (light micro-shift `#ddd`→`#e4e4e7`; dark becomes visible `#33333c`) |

Non-hex, listed for completeness (KEEP, theme-agnostic): all `rgba(0,0,0,…)` box-shadows and the dialog `::backdrop`; `rgba(217,119,6,…)` held-back washes (amber family, see 726 row).

Tally: 63 hex-bearing lines (66 occurrences; 1205–1207 carry color+border pairs) = 55 KEEP + 5 TOKENIZE + 2 BG-RAISED + 1 COMMENT lines. Task 3 verifies this tally against a fresh grep before editing — a mismatch means the snapshot drifted: reclassify the new/changed occurrences by the same rules and record the delta in the report, don't guess.

---

### Task 1: Baseline both-themes screenshot matrix

**Files (outside repo):**
- Create: `<scratchpad>/b18-screens/server.py` (copy of `<scratchpad>/b11b4-screens/server.py`, byte-identical), `<scratchpad>/b18-screens/shoot-themes.mjs`, `<scratchpad>/b18-screens/before/*.png`

**Interfaces:**
- Produces: the driver Task 4 re-runs unchanged and the `before/` set (24 PNGs). **No commit** — artifact task; the ledger records completion, the controller verifies the artifact set (there is no diff to review).

- [ ] **Step 1: Stack up**

Same bring-up as the B11+B4 harness, from its proven scripts: copy `server.py`, launch from `backend/` with `PYTHONPATH=/Users/markus/IdeaProjects/fabulous-writing/backend uv run python <scratchpad>/b18-screens/server.py` (background, record PID); then from `frontend/`: `VITE_API_URL=http://127.0.0.1:8001 npm run build`, confirm via `grep -rl 8001 dist/assets | head -1`, and `npx vite preview --port 4199 --strictPort` (background, record PID). Acceptance: curl login returns a token AND the driver's browser login reaches `.header` (proves CORS).

- [ ] **Step 2: Write the driver**

Create `<scratchpad>/b18-screens/shoot-themes.mjs`:

```js
import { chromium } from '/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs'
import { globSync } from 'node:fs'

const OUT = process.argv[2] // .../before or .../after
const exe = globSync(
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
).sort().reverse()[0]
const browser = await chromium.launch({ executablePath: exe })

async function newPage(colorScheme, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, colorScheme })
  const p = await ctx.newPage()
  await p.goto('http://localhost:4199')
  await p.waitForSelector('.login-card')
  return p
}

// Gate shots: both widths x both themes (4)
for (const theme of ['light', 'dark']) {
  for (const [label, vp] of [
    ['wide', { width: 1280, height: 800 }],
    ['narrow', { width: 640, height: 900 }],
  ]) {
    const g = await newPage(theme, vp)
    await g.screenshot({ path: `${OUT}/gate-${theme}-${label}.png` })
    await g.context().close()
  }
}

// Signed-in surfaces per theme (10 each = 20)
for (const theme of ['light', 'dark']) {
  const p = await newPage(theme)
  await p.fill('input[type=email]', 'admin@scratch.local')
  await p.fill('input[type=password]', 'scratch-admin-pw-1')
  await p.click('.login-submit')
  await p.waitForSelector('.header')
  await p.waitForSelector('.doc-list')
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${OUT}/editor-${theme}.png` })
  for (const [i, name] of [[2, 'rules'], [3, 'terminology'], [4, 'profiles'], [5, 'admin']]) {
    await p.click(`.view-switch button:nth-child(${i})`)
    await p.waitForTimeout(600)
    if (name === 'rules') {
      // Open the first rule-pattern <details> so .rule-pattern pre (a
      // --bg-raised consumer) is actually visible in the shot — closed by
      // default, it would make that edit matrix-invisible.
      await p.click('.rule-pattern summary')
      await p.waitForTimeout(200)
    }
    await p.screenshot({ path: `${OUT}/${name}-${theme}.png` })
  }
  await p.click('.view-switch button:nth-child(1)')
  // account menu (open)
  await p.click('.account-badge')
  await p.waitForSelector('.account-menu')
  await p.screenshot({ path: `${OUT}/account-menu-${theme}.png` })
  // password dialog (first account-menu item). ONE Escape suffices: the
  // menu already closed itself before opening the dialog (AccountMenu
  // setOpen(false) precedes setPasswordOpen(true)).
  await p.click('.account-menu > button')
  await p.waitForSelector('dialog.app-dialog')
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${OUT}/password-dialog-${theme}.png` })
  await p.keyboard.press('Escape')
  // folder for menu/dialog surfaces
  await p.click('.doc-sidebar-head .doc-sidebar-toggle')
  await p.fill('.doc-sidebar input', `Sweep-${theme}`)
  await p.keyboard.press('Enter')
  await p.waitForSelector('.folder-head')
  await p.hover('.folder-head') // .doc-menu-button is visibility:hidden until hover
  await p.click('.folder-head .doc-menu-button')
  await p.waitForSelector('.doc-menu')
  await p.screenshot({ path: `${OUT}/doc-menu-${theme}.png` })
  // folder menu order: new-document(1), defaults(2), rename(3), delete(4)
  await p.click('.doc-menu button:nth-child(2)')
  await p.waitForSelector('.folder-defaults-dialog')
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${OUT}/folder-defaults-${theme}.png` })
  await p.keyboard.press('Escape')
  await p.hover('.folder-head')
  await p.click('.folder-head .doc-menu-button')
  await p.click('.doc-menu-delete')
  await p.waitForSelector('.confirm-dialog')
  await p.screenshot({ path: `${OUT}/confirm-dialog-${theme}.png` })
  await p.keyboard.press('Escape')
  await p.context().close()
}
await browser.close()
```

(The folder name is per-theme — `` `Sweep-${theme}` `` — because both theme passes share one scratch DB per run and `addFolder` 409s on duplicates, leaving the input open.)

- [ ] **Step 3: Capture the baseline**

`mkdir -p <scratchpad>/b18-screens/before && node <scratchpad>/b18-screens/shoot-themes.mjs <scratchpad>/b18-screens/before`
Expected: **24 PNGs** (4 gate + 10 surfaces × 2 themes). Sanity-verify the baseline captures the reported symptoms: `profiles-dark.png` shows the white listboxes/textareas/chips; `doc-menu-dark.png` and `account-menu-dark.png` show near-black item text; note in the report whether `account-menu-dark.png` shows the white-popover compositing artifact (it appears in some renders, not all — record what THIS run shows).

- [ ] **Step 4: Teardown**

Kill recorded PIDs; verify :8001/:4199 free; plain `npm run build` from `frontend/`; report artifact inventory.

---

### Task 2: Mechanism fixes — `color-scheme` and `--bg-raised`

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/App.css` (only the two `--bg-raised` fallback drops)

**Interfaces:** consumes nothing; produces the token/scheme base Task 3's sweep and Task 4's matrix build on.

- [ ] **Step 1: `index.css` theme blocks**

In `:root` (light tokens), add as the FIRST declaration and one new token after `--accent-soft` (the `...` lines below are elision — the existing tokens stay exactly as they are, only the shown lines are added):

```css
:root {
  color-scheme: light;
  --bg: #ffffff;
  ...
  --accent-soft: #6e56cf1e;
  /* Raised surface (pills, code blocks) — must read as "lifted" against
     --panel in both themes. Referenced by .rules-count and
     .rule-pattern pre (B18, #63 — was undefined, light fallbacks won in
     both themes). */
  --bg-raised: #eee;
  ...
}
```

In the `@media (prefers-color-scheme: dark)` block, mirror both:

```css
  :root {
    color-scheme: dark;
    --bg: #17171b;
    ...
    --accent-soft: #9b7ef72a;
    --bg-raised: #26262e;
    ...
  }
```

(`color-scheme` makes the UA render form-control internals, scrollbars, and the default canvas in the matching scheme — the systemic fix for the white listboxes/textareas, dark-on-dark input icons, and the leading hypothesis for the white account-menu composite.)

Contrast check for the one pinned value (spec's WCAG requirement): `--bg-raised: #26262e` is a background; the text on it is `--text #ededf0` (≈13.5:1) or `--text-dim #9d9da8` (≈5.6:1) — both clear 4.5:1. No other new color values are introduced by this plan.

- [ ] **Step 2: Drop the two `--bg-raised` fallbacks in `App.css`**

- `.rules-count`: `background: var(--bg-raised, #eee);` → `background: var(--bg-raised);`
- `.rule-pattern pre`: `background: var(--bg-raised, #f6f6f6);` → `background: var(--bg-raised);`

- [ ] **Step 3: Gates**

From `frontend/`: `npm test -- --run` (all green — nothing asserts colors) and `npm run build` (clean).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css frontend/src/App.css
git commit -m "fix(ui): dark-mode mechanisms — color-scheme and --bg-raised token (B18, #63)"
```
(with the two mandatory trailer lines)

---

### Task 3: Classified hex sweep

**Files:**
- Modify: `frontend/src/App.css` (exactly the five TOKENIZE rows)

**Interfaces:** consumes Task 2's tokens; produces the final CSS Task 4 verifies.

- [ ] **Step 1: Verify the classification tally**

Run `grep -cn "#[0-9a-fA-F]\{3,8\}\b" frontend/src/App.css` — expect 63 hex-bearing lines pre-Task-2 (post-Task-2: the two `--bg-raised` fallback lines are gone, so expect **61**; every remaining line must still map to its table row). On mismatch: reclassify the delta by the table's rules and record it in the report.

- [ ] **Step 2: Apply the five TOKENIZE edits**

1. `.advice-note` (~745): `color: #6b7280;` → `color: var(--text-dim);`
2. `.tier-option` (~1512): `border: 1px solid #d8d8e0;` → `border: 1px solid var(--border);`
3. `.tier-option` (~1514): `background: #fff;` → `background: var(--bg);`
4. `.pinned-note` (~1531): `color: #667;` → `color: var(--text-dim);`
5. `.admin-users th, .admin-users td` (~2154): `border-bottom: 1px solid #ddd;` → `border-bottom: 1px solid var(--border);`

Everything else in the table is KEEP/COMMENT — touch nothing else.

- [ ] **Step 3: Gates**

From `frontend/`: `npm test -- --run` green; `npm run build` clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.css
git commit -m "fix(ui): tokenize light-chrome hex colors — advice note, tier chips, pinned note, admin borders (B18, #63)"
```
(with the two mandatory trailer lines)

---

### Task 4: After-matrix and comparison

**Files (outside repo):**
- Create: `<scratchpad>/b18-screens/after/*.png`, `<scratchpad>/b18-screens/COMPARISON.md`

**Interfaces:** consumes Task 1's driver unchanged. **No commit.**

- [ ] **Step 1: Re-run and capture**

Task 1's Step 1 bring-up (same commands; build now contains Tasks 2–3), then `mkdir -p <scratchpad>/b18-screens/after && node <scratchpad>/b18-screens/shoot-themes.mjs <scratchpad>/b18-screens/after`. 24 PNGs.

- [ ] **Step 2: The comparison contract**

Write `<scratchpad>/b18-screens/COMPARISON.md`, one line per pair (24): `identical` / `intended diff: <what>` / `UNINTENDED: <what>`.

**Light pairs (12) — pixel-identical (`cmp -s`) expected for 9 of 12; the other 3 read `identical OR the listed micro-diff` (a missing micro-diff is fine, an extra one is not):**
- `rules-light.png`: `.rule-pattern pre` background `#f6f6f6`→`#eee` (the first `<details>` is opened by the driver in both runs, so the pre is on screen); `.rules-count` visually unchanged (`#eee`→`#eee`).
- `profiles-light.png`: tier-chip border `#d8d8e0`→`#e4e4e7` (near-invisible; chip background `#fff`→`var(--bg)` is byte-identical in light).
- `admin-light.png`: table border `#ddd`→`#e4e4e7` (near-invisible).
- Matrix-invisible by design, code-review-only edits (record as such in COMPARISON.md, do not chase them in pixels): `.advice-note` (needs LLM advice on screen) and `.pinned-note` (needs a pinned-provider profile) — neither state exists on the scratch stack.
- Any UA-chrome rendering shift from `color-scheme: light` now being explicit (expected: none; classify if seen).

**Dark pairs (12) — each must show its fix:**
- `doc-menu-dark.png`, `account-menu-dark.png`: menu items readable (light text, not black) — this is the empirical proof that `color-scheme: dark` makes UA `ButtonText` follow the theme (the spec's dropped-fix-2 amendment relies on exactly this shot). If the items still render black, the amendment is falsified — STOP and report; the pre-agreed remedy is reinstating fix 2 as `button:where(:enabled) { color: inherit }` (specificity (0,0,1): preserves `.doc-menu-delete` etc. and the UA disabled greying), not an ad-hoc rule.
- **`account-menu-dark.png` — the hypothesis arbiter:** record an explicit verdict line `account-menu dark composite: DARK` or `: WHITE`. If WHITE survives, STOP: report it as an open diagnosis (per the spec, it becomes a dedicated loop — do not proceed to Task 5).
- `password-dialog-dark.png`: Cancel readable; input key icons light-scheme-correct.
- `profiles-dark.png`: listboxes/textareas dark-chrome; tier chips dark with `--border`; selected chip unchanged (`#5b5bd6`).
- `rules-dark.png`: `.rules-count` pill and `.rule-pattern pre` on `--bg-raised #26262e`, readable.
- `admin-dark.png`: table borders visible (`#33333c`), create/reset buttons dark-chrome.
- `editor-dark.png`, `terminology-dark.png`, `folder-defaults-dark.png`, `confirm-dialog-dark.png`, `gate-dark-*`: theme-correct, no black-on-dark text anywhere.
- Held-back amber: not exercisable on the scratch stack; record `amber contrast: 3.30:1 on dark --panel (fails AA), measured at plan time; follow-up ticket filed in Task 5`.

Any `UNINTENDED`: STOP, report — never adjust CSS to make a pair pass.

- [ ] **Step 3: Teardown and report**

Kill own PIDs, verify ports free, plain `npm run build`, report the full comparison table verbatim.

---

### Task 5: Architecture doc

**Files:**
- Modify: `docs/frontend-architecture.md`

**Interfaces:** consumes the shipped state; nothing consumes it. (LOGBOOK entry happens at PR time, outside this plan.)

- [ ] **Step 1: Add the theming section**

`docs/frontend-architecture.md` currently has NO prose describing the theme tokens or `prefers-color-scheme` (verified at plan time — only the B11 button-font paragraph exists). Write a NEW short section (placed near the B11 button-reset paragraph, matching the doc's style) describing the theme root: `index.css` declares `color-scheme` per theme (UA form-control chrome, scrollbars, and canvas follow the app theme; system colors like ButtonText resolve per scheme — the reason buttons need no author color reset), defines the tokens including `--bg-raised` (both themes), and the classification rule from B18: semantic colors (danger/severity/category palettes) stay literal, surface chrome uses tokens.

- [ ] **Step 2: File the amber-contrast follow-up ticket**

```bash
gh issue create --repo saigyo/fabulous-writing \
  --title "Held-back amber text fails contrast in dark mode (#b45309, 3.30:1)" \
  --body "Found during B18 (#63): .suggestion-button.held-back:hover and .held-back-reason use color: #b45309 (amber-700), which measures 3.30:1 on dark --panel (#1e1e24) — below WCAG AA 4.5:1. Kept out of B18 per its no-drive-by rule (semantic warning family). Fix idea: a theme-aware amber (e.g. lighter amber for dark via a token or media query), keeping light mode as is. Verify with the B18 both-themes harness; needs a document with held-back suggestions on screen to exercise."
```

- [ ] **Step 3: Verify and gates**

`grep -nE "bg-raised|color-scheme" docs/frontend-architecture.md` → the new prose appears; from `frontend/`: `npm test -- --run` and `npm run build` (unchanged code — clean-tree confirmation).

- [ ] **Step 4: Commit**

```bash
git add docs/frontend-architecture.md
git commit -m "docs(frontend): theme-root section — color-scheme, tokens, B18 color classification (#63)"
```
(with the two mandatory trailer lines)
