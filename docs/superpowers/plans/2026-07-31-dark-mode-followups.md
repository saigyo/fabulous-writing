# Dark-Mode Follow-ups (#65, #66) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two B18-parked dark-mode defects — held-back amber text failing WCAG AA (#65) and the CodeMirror editor ignoring dark mode entirely (#66) — with zero light-mode change.

**Architecture:** #65 is a token swap: a new `--held-back` custom property (light keeps today's `#b45309`, dark gets AA-passing `#f59e0b`) replaces the two hard-coded declarations. #66 adds `frontend/src/editor/theme.ts`: a CodeMirror `Compartment` that is empty in light mode and, in dark mode, holds a `dark: true` theme (flips CM's built-in dark chrome, token-aligns the gutter) plus a `themeType: 'dark'` highlight style — built from `defaultHighlightStyle.specs` with exactly two color substitutions, because a main highlighter *replaces* the fallback default rather than layering on it; a `matchMedia` listener follows live OS theme changes.

**Tech Stack:** React 19 + TS + Vite frontend; CodeMirror 6 (`@codemirror/view` 6.43.6, `@codemirror/state` 6.7.1; `@codemirror/language` 6.12.4 and `@lezer/highlight` 1.2.3 newly promoted to direct deps); Vitest (default environment `node` — DOM tests opt in per file with `// @vitest-environment happy-dom`); the B18 screenshot harness (playwright-core, scratch stack :8001/:4199).

**Spec:** `docs/superpowers/specs/2026-07-31-dark-mode-followups-design.md`. The spec governs on any conflict.

## Global Constraints

- Light mode is **byte-identical** across the whole screenshot matrix — this item declares NO intended light-mode diffs (`cmp -s` on every light-rendering pair). Editor-content shots are element-scoped to `.editor-area` so the sidebar's minute-granular time label cannot race the gate.
- Exact values: `--held-back` light `#b45309`, dark `#f59e0b`; the dark highlight style is `defaultHighlightStyle.specs` with exactly two color substitutions — the `tags.meta` entry → `var(--text-dim)`, the array entry carrying `tags.url` → `var(--accent)`; gutter alignment `var(--panel)` / `var(--text-dim)`, active-line gutter `var(--bg-raised)`. No gutter border is declared (CM's dark base draws none — a color alone would be dead config).
- OS-follow only — no manual theme toggle, no `data-theme` plumbing; the editor must follow a mid-session OS theme change live (no reload).
- Caret, selection, and active line in dark keep CM's built-in base-dark values — no custom overrides.
- New direct dependencies pinned to the versions already resolved in the lockfile: `@codemirror/language@6.12.4`, `@lezer/highlight@1.2.3`. No other dependency changes.
- Never kill, restart, or start anything on ports **5173** or **8000**. Scratch stack uses **:8001** (backend, tempfile DB) and **:4199** (vite preview); kill only PIDs you recorded; run a plain `npm run build` after the last screenshot run to restore production `dist/`.
- Gates before every commit: `npm test -- --run` green and `npm run build` clean (run from `frontend/`). Backend untouched by this plan.
- Mutation-verify every guard test: temporarily break the guarded line, watch the test fail, restore.
- Commit trailers: every commit command below embeds the two mandatory trailer lines verbatim — do not strip them.
- The session controller opens the implementation PR (finishing-a-development-branch) with separate closing keywords `Closes #65. Closes #66.` (a shared keyword only binds its first ref) — no task below creates the PR.
- LOGBOOK: the entry is appended by the session controller once the implementation PR number exists (repo convention, entries keyed by PR number) — it is not part of any task below.

**Scratch workspace for the harness:** `/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens`. Shell state does NOT persist between tool calls, so **every** command block below re-declares `SCRATCH=` on its first line — keep that line when executing.

---

### Task 1: Harness + baseline matrix (`before/`)

Extends the proven B18 driver with an editor-markdown segment (typed content, selection, caret, live theme flip) and captures the pre-change matrix. Runs before any code change.

**Files:**
- Create: `$SCRATCH/server.py` (scratch artifact, not committed)
- Create: `$SCRATCH/shoot-themes.mjs` (scratch artifact, not committed)
- Create: `$SCRATCH/before/*.png` (28 shots)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `$SCRATCH/before/` shots and a working, re-runnable harness; Task 4 re-runs `shoot-themes.mjs` **unchanged** against `$SCRATCH/after`.

- [ ] **Step 0: Feature branch**

If the SDE controller has not already created one, create the implementation branch off the current base:

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git switch -c dark-mode-followups-impl
```

All commits in Tasks 2, 3 and 5 land on this branch — never on `main`.

- [ ] **Step 1: Write the scratch backend**

Create the workspace first, then write `$SCRATCH/server.py` exactly:

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
mkdir -p $SCRATCH/before $SCRATCH/after
```

```python
import os
import pathlib
import tempfile

os.environ["FW_AUTH_SECRET"] = "scratch-secret-scratch-secret-32chars!!"
os.environ["FW_ADMIN_EMAIL"] = "admin@scratch.local"
os.environ["FW_ADMIN_PASSWORD"] = "scratch-admin-pw-1"

import uvicorn
from app.core.config import Settings
from app.main import create_app

db = pathlib.Path(tempfile.mkdtemp(prefix="df-")) / "scratch.db"
# cors override is REQUIRED: the default origins list is
# ["http://localhost:5173"], which would reject every browser fetch from
# the :4199 preview — the login just looks like a generic failure (curl
# can't catch this; it isn't subject to CORS).
app = create_app(Settings(db_path=db, cors={"origins": ["http://localhost:4199"]}))
uvicorn.run(app, host="127.0.0.1", port=8001)
```

- [ ] **Step 2: Write the driver**

Write `$SCRATCH/shoot-themes.mjs` exactly (B18's driver plus the final editor-markdown segment; every quirk comment is load-bearing — keep them):

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

// Signed-in surfaces per theme (12 each = 24)
for (const theme of ['light', 'dark']) {
  const p = await newPage(theme)
  await p.fill('input[type=email]', 'admin@scratch.local')
  await p.fill('input[type=password]', 'scratch-admin-pw-1')
  await p.click('.login-submit')
  await p.waitForSelector('.header')
  // '.doc-list' is ambiguous once folders exist (each folder renders its
  // own <ul class="doc-list folder-docs"> ahead of the ungrouped list in
  // DOM order, and the light pass's folder persists into the dark pass on
  // the shared scratch DB). '.doc-sidebar' is always rendered non-empty.
  await p.waitForSelector('.doc-sidebar')
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${OUT}/editor-${theme}.png` })
  for (const [i, name] of [[2, 'rules'], [3, 'terminology'], [4, 'profiles'], [5, 'admin']]) {
    await p.click(`.view-switch button:nth-child(${i})`)
    await p.waitForTimeout(600)
    if (name === 'rules') {
      // Open the first rule-pattern <details> so .rule-pattern pre is
      // visible — closed by default it would be matrix-invisible.
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
  // menu already closed itself before opening the dialog.
  await p.click('.account-menu > button')
  await p.waitForSelector('dialog.app-dialog')
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${OUT}/password-dialog-${theme}.png` })
  await p.keyboard.press('Escape')
  // folder for menu/dialog surfaces. ConfirmDialog's Escape cancels (by
  // design), so the light pass's folder survives into the dark pass —
  // scope selectors to this theme's folder name to disambiguate.
  const folderSel = `.folder-head:has-text("Sweep-${theme}")`
  await p.click('.doc-sidebar-head .doc-sidebar-toggle')
  await p.fill('.doc-sidebar input', `Sweep-${theme}`)
  await p.keyboard.press('Enter')
  await p.waitForSelector(folderSel)
  await p.hover(folderSel) // .doc-menu-button is visibility:hidden until hover
  await p.click(`${folderSel} .doc-menu-button`)
  await p.waitForSelector('.doc-menu')
  await p.screenshot({ path: `${OUT}/doc-menu-${theme}.png` })
  // folder menu order: new-document(1), defaults(2), rename(3), delete(4)
  await p.click('.doc-menu button:nth-child(2)')
  await p.waitForSelector('.folder-defaults-dialog')
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${OUT}/folder-defaults-${theme}.png` })
  await p.keyboard.press('Escape')
  await p.hover(folderSel)
  await p.click(`${folderSel} .doc-menu-button`)
  await p.click('.doc-menu-delete')
  await p.waitForSelector('.confirm-dialog')
  await p.screenshot({ path: `${OUT}/confirm-dialog-${theme}.png` })
  await p.keyboard.press('Escape')
  // ---- NEW (#65/#66): editor with markdown content, selection, caret,
  // live theme flip. Last segment of the pass, so every earlier shot
  // predates the created document. Content stays under the 20-word
  // auto-title threshold so no title-generation API call fires. The link
  // uses [text](url) form deliberately: markdown() is CommonMark (no GFM
  // autolink), so only a link destination ever gets tags.url.
  // Login auto-creates a document when the list is empty (runInit), so
  // the pass starts with docs already present (1 light pass / 2 dark
  // pass). Capture the count and wait for it to GROW — a hardcoded
  // equality wait would either resolve before the create lands (no
  // barrier) or never (timeout).
  const docsBefore = await p.locator('.doc-item').count()
  await p.click('.doc-new')
  // .cm-content exists the whole session (the editor is permanently
  // mounted), so it is no barrier. The real barrier is the new document
  // appearing in the sidebar, plus a settle so createNewDocument()'s
  // full-document hydration replace lands BEFORE typing starts — it
  // would otherwise wipe typed text mid-stream, nondeterministically.
  await p.waitForFunction(
    (n) => document.querySelectorAll('.doc-item').length >= n,
    docsBefore + 1,
  )
  await p.waitForTimeout(600)
  await p.click('.editor .cm-content')
  await p.keyboard.type(
    '# Dark title\n\nSome **bold** text and [docs](https://example.com/docs)\n\n---\n\nPlain closing line.',
  )
  // Autosave debounce (1500ms) + fast check (1000ms) settle.
  await p.waitForTimeout(1800)
  await p.keyboard.press('ControlOrMeta+a')
  // Element shot of the editor pane only: excludes the sidebar's
  // minute-granular .doc-time label, whose whole-minute rounding would
  // race the byte-identity gate on wall-clock drift between the before
  // and after runs. animations: 'disabled' cancels the infinite
  // caret-blink animation to its initial (visible) state.
  await p.locator('.editor-area').screenshot({
    path: `${OUT}/editor-md-${theme}.png`,
    animations: 'disabled',
  })
  // Live OS-theme flip must restyle the editor without a reload (#66).
  const flipTo = theme === 'dark' ? 'light' : 'dark'
  await p.emulateMedia({ colorScheme: flipTo })
  await p.waitForTimeout(300)
  await p.locator('.editor-area').screenshot({
    path: `${OUT}/editor-md-flip-to-${flipTo}.png`,
    animations: 'disabled',
  })
  await p.context().close()
}
await browser.close()
```

- [ ] **Step 3: Build the frontend against the scratch backend and start the stack**

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
mkdir -p $SCRATCH/before $SCRATCH/after
cd /Users/markus/IdeaProjects/fabulous-writing/backend
nohup uv run python $SCRATCH/server.py > $SCRATCH/backend.log 2>&1 &
echo $! > $SCRATCH/backend.pid
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
VITE_API_URL=http://127.0.0.1:8001 npm run build
nohup npx vite preview --port 4199 --strictPort > $SCRATCH/preview.log 2>&1 &
echo $! > $SCRATCH/preview.pid
sleep 2
curl -s -o /dev/null -w 'backend %{http_code}\n' http://127.0.0.1:8001/api/health
curl -s -o /dev/null -w 'preview %{http_code}\n' http://localhost:4199/
```

Expected: `backend 200`, `preview 200`. If :4199 or :8001 is already in use, STOP and report — never touch other ports.

- [ ] **Step 4: Run the baseline**

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
node $SCRATCH/shoot-themes.mjs $SCRATCH/before
ls $SCRATCH/before | wc -l
```

Expected: 28 files (4 gate + 12 per theme). Eyeball `editor-md-dark.png`: it must show the BUG — light gutter, markdown marks nearly invisible. `editor-md-flip-to-dark.png` must show a still-light editor (the flip reaches the app CSS but not CM).

- [ ] **Step 5: Tear down the stack**

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
kill $(cat $SCRATCH/backend.pid) $(cat $SCRATCH/preview.pid)
```

Leave `$SCRATCH` in place — Task 4 reuses the harness with a fresh stack.

- [ ] **Step 6: Report**

No commit (nothing in the repo changed). Report shot count and the confirmed baseline defects.

---

### Task 2: `--held-back` token (#65)

**Files:**
- Modify: `frontend/src/index.css` (anchors: `--bg-raised: #eee;` at line 14, `--bg-raised: #26262e;` at line 31)
- Modify: `frontend/src/App.css` (`:hover` color at line 731, `.held-back-reason` color at line 738)

**Interfaces:**
- Consumes: nothing.
- Produces: `--held-back` custom property (light `#b45309`, dark `#f59e0b`) — referenced by App.css only; no TS surface.

- [ ] **Step 1: Define the token in both theme blocks**

In `frontend/src/index.css`, add to the `:root` block, directly after the `--bg-raised: #eee;` line (line 14):

```css
  /* Held-back-suggestion amber (#65): light keeps the original amber-700;
     dark uses amber-500 — 7.7:1 on --panel, 6.3:1 on the held-back hover
     wash, both clear WCAG AA (amber-700 measured only 3.30:1 on dark
     --panel). */
  --held-back: #b45309;
```

In the `@media (prefers-color-scheme: dark)` block, directly after `--bg-raised: #26262e;` (line 31):

```css
    --held-back: #f59e0b;
```

- [ ] **Step 2: Use the token**

In `frontend/src/App.css`, change exactly two declarations (leave the `#d97706` border and the `rgba(217, 119, 6, …)` washes untouched):

```css
.suggestion-button.held-back:hover {
  color: var(--held-back);
  background: rgba(217, 119, 6, 0.15);
}

.held-back-reason {
  margin: 0.15rem 0 0;
  font-size: 0.72rem;
  color: var(--held-back);
}
```

- [ ] **Step 3: Gates**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
npm test -- --run
npm run build
```

Expected: all tests pass, build clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git add frontend/src/index.css frontend/src/App.css
git commit -m "$(cat <<'EOF'
fix(ui): theme-aware held-back amber for dark-mode AA contrast (#65)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 3: Editor dark theme (#66)

**Files:**
- Create: `frontend/src/editor/theme.ts`
- Create: `frontend/src/editor/theme.test.ts`
- Modify: `frontend/src/editor/Editor.tsx`
- Modify: `frontend/package.json` (+ lockfile via npm)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `editorTheme(): Extension` and `watchTheme(view: EditorView): () => void` from `./theme`, consumed only by `Editor.tsx`.

- [ ] **Step 1: Promote the transitive deps to direct**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
npm install @codemirror/language@6.12.4 @lezer/highlight@1.2.3
git diff package-lock.json --stat
```

Expected: `package.json` gains the two deps with `^`-ranges at exactly those versions; the lockfile diff is minimal (no version bumps of existing packages — if versions move, STOP and report).

- [ ] **Step 2: Write the failing test**

Create `frontend/src/editor/theme.test.ts`. The `@vitest-environment` docblock is REQUIRED: the repo's vitest default environment is `node` (no `test.environment` in `vite.config.ts`); DOM-touching test files opt in per file.

```ts
// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorTheme, watchTheme } from './theme'

type Listener = (event: { matches: boolean }) => void

/**
 * happy-dom does implement matchMedia, but not a controllable one. The
 * stub reaches window.matchMedia because window === globalThis under
 * vitest's happy-dom environment.
 */
function stubMatchMedia(matches = false) {
  const listeners = new Set<Listener>()
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: (_: 'change', fn: Listener) => listeners.add(fn),
    removeEventListener: (_: 'change', fn: Listener) => listeners.delete(fn),
  }))
  return {
    fire(m: boolean) {
      for (const fn of [...listeners]) fn({ matches: m })
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('editorTheme', () => {
  it('pre-loads the dark scheme at creation', () => {
    stubMatchMedia(true)
    const state = EditorState.create({ extensions: [editorTheme()] })
    expect(state.facet(EditorView.darkTheme)).toBe(true)
  })

  it('contributes nothing in light', () => {
    stubMatchMedia(false)
    const state = EditorState.create({ extensions: [editorTheme()] })
    expect(state.facet(EditorView.darkTheme)).toBe(false)
  })
})

describe('watchTheme', () => {
  it('reconfigures the view when the OS scheme changes', () => {
    const media = stubMatchMedia()
    const dispatch = vi.fn()
    watchTheme({ dispatch } as unknown as EditorView)
    media.fire(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toHaveProperty('effects')
  })

  it('stops following after cleanup', () => {
    const media = stubMatchMedia()
    const dispatch = vi.fn()
    const stop = watchTheme({ dispatch } as unknown as EditorView)
    stop()
    media.fire(true)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
npm test -- --run src/editor/theme.test.ts
```

Expected: FAIL — `./theme` does not exist.

- [ ] **Step 4: Implement `theme.ts`**

Create `frontend/src/editor/theme.ts`:

```ts
import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language'
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const QUERY = '(prefers-color-scheme: dark)'

// dark: true flips CM's darkTheme facet, activating the complete built-in
// dark chrome (caret #ddd, focused selection #233, dark active line,
// panels, tooltips). The body token-aligns only the gutter family;
// caret/selection/active line keep the proven base-dark values. No gutter
// border: CM's dark base draws none (width/style exist only under its
// &light rules), so a color alone would be dead config (#66).
const darkChrome = EditorView.theme(
  {
    '.cm-gutters': {
      backgroundColor: 'var(--panel)',
      color: 'var(--text-dim)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--bg-raised)',
    },
  },
  { dark: true },
)

// basicSetup registers defaultHighlightStyle as a FALLBACK highlighter;
// a main highlighter — which a themeType:'dark' style is while the dark
// facet is on — replaces the fallback wholesale rather than layering on
// it. So the dark style is the default's own specs with exactly two
// color substitutions; every non-color decoration (heading
// bold+underline, strong, emphasis, link underline) survives verbatim.
// The two: the tags.meta entry (#404740 — markdown formatting marks via
// processingInstruction's tag-parent fallback) and the array entry
// carrying tags.url/tags.contentSeparator (#219 — link destinations and
// thematic breaks; the entry also carries atom/bool/labelName, none
// produced by markdown), both unreadable on the dark canvas.
const darkSpecs = defaultHighlightStyle.specs.map((spec) =>
  spec.tag === tags.meta
    ? { ...spec, color: 'var(--text-dim)' }
    : Array.isArray(spec.tag) && spec.tag.includes(tags.url)
      ? { ...spec, color: 'var(--accent)' }
      : spec,
)

const darkMarkdownColors = syntaxHighlighting(
  HighlightStyle.define(darkSpecs, { themeType: 'dark' }),
)

// Module-level singleton shared across editor remounts — a Compartment
// is just a reconfiguration key, safe to reuse.
const compartment = new Compartment()

function forScheme(dark: boolean): Extension {
  // Light mode contributes zero style rules — the light editor must stay
  // byte-identical (spec: no declared light-mode diffs).
  return dark ? [darkChrome, darkMarkdownColors] : []
}

/** Theme extension pre-loaded for the OS scheme at view creation. */
export function editorTheme(): Extension {
  return compartment.of(forScheme(window.matchMedia(QUERY).matches))
}

/**
 * Follow live OS theme changes. Returns the cleanup that unregisters the
 * listener; callers run it before destroying the view.
 */
export function watchTheme(view: EditorView): () => void {
  const media = window.matchMedia(QUERY)
  const onChange = (event: MediaQueryListEvent) => {
    view.dispatch({
      effects: compartment.reconfigure(forScheme(event.matches)),
    })
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- --run src/editor/theme.test.ts
```

Expected: all four tests PASS.

- [ ] **Step 6: Mutation-verify the guards**

1. In `watchTheme`, comment out `media.addEventListener('change', onChange)` → "reconfigures the view…" must FAIL. Restore.
2. In `watchTheme`, replace the returned cleanup with `() => {}` → "stops following after cleanup" must FAIL. Restore.
3. In `forScheme`, return `[]` unconditionally → "pre-loads the dark scheme at creation" must FAIL. Restore.
4. Re-run: all four PASS again.

- [ ] **Step 7: Wire into the editor**

In `frontend/src/editor/Editor.tsx`:

Add the import directly after the `import { setEditorView } from './editorRef'` line:

```ts
import { editorTheme, watchTheme } from './theme'
```

Add `editorTheme(),` to the extensions array, directly after `EditorView.lineWrapping,`:

```ts
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        editorTheme(),
        findingsField,
```

After `setEditorView(view)`, register the watcher:

```ts
    setEditorView(view)
    const stopThemeWatch = watchTheme(view)
```

And run its cleanup in the teardown, before `view.destroy()`:

```ts
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      scheduler.dispose()
      stopThemeWatch()
      setEditorView(null)
      view.destroy()
    }
```

- [ ] **Step 8: Gates**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
npm test -- --run
npm run build
```

Expected: full suite green, build clean.

- [ ] **Step 9: Commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git add frontend/package.json frontend/package-lock.json frontend/src/editor/theme.ts frontend/src/editor/theme.test.ts frontend/src/editor/Editor.tsx
git commit -m "$(cat <<'EOF'
fix(editor): dark-mode chrome and markdown colors via darkTheme compartment (#66)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 4: After matrix, comparison contract, probes

**Files:**
- Create: `$SCRATCH/after/*.png` (28 shots)
- Create: `$SCRATCH/probe.mjs` (scratch artifact)
- Create: `$SCRATCH/COMPARISON.md` (scratch artifact)

**Interfaces:**
- Consumes: Task 1's harness (`server.py`, `shoot-themes.mjs` — re-run **unchanged**); Tasks 2–3 committed on the branch.
- Produces: the verification verdict — the branch's acceptance evidence.

- [ ] **Step 1: Fresh stack, rebuilt frontend**

Fresh tempfile DB by construction; the rebuild puts the fixes in the served bundle:

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
cd /Users/markus/IdeaProjects/fabulous-writing/backend
nohup uv run python $SCRATCH/server.py > $SCRATCH/backend.log 2>&1 &
echo $! > $SCRATCH/backend.pid
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
VITE_API_URL=http://127.0.0.1:8001 npm run build
nohup npx vite preview --port 4199 --strictPort > $SCRATCH/preview.log 2>&1 &
echo $! > $SCRATCH/preview.pid
sleep 2
curl -s -o /dev/null -w 'backend %{http_code}\n' http://127.0.0.1:8001/api/health
curl -s -o /dev/null -w 'preview %{http_code}\n' http://localhost:4199/
```

Expected: `backend 200`, `preview 200`. If :4199 or :8001 is already in use, STOP and report — never touch other ports.

- [ ] **Step 2: Run the after matrix**

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
node $SCRATCH/shoot-themes.mjs $SCRATCH/after
ls $SCRATCH/after | wc -l
```

Expected: 28 files.

- [ ] **Step 3: Light byte-identity — the whole light set, no exceptions**

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
cd $SCRATCH
LIGHT="gate-light-wide gate-light-narrow editor-light rules-light terminology-light profiles-light admin-light account-menu-light password-dialog-light doc-menu-light folder-defaults-light confirm-dialog-light editor-md-light editor-md-flip-to-light"
for name in $LIGHT; do
  cmp -s before/$name.png after/$name.png || echo "DIFF: $name"
done
```

Expected: **no output**. (`editor-md-flip-to-light` is the dark pass flipped to light — a light rendering, hence in this set.) Any `DIFF` line: STOP, inspect the pair, report — do not rationalize a diff away.

- [ ] **Step 4: Dark acceptance checklist**

Read `after/editor-md-dark.png` and `after/editor-md-flip-to-dark.png` and verify each item against the corresponding `before/` shot:

- gutter renders in the `--panel` family (dark), line numbers readable (`--text-dim`)
- caret visible (light bar, not black)
- selection visible on the dark canvas
- markdown marks (`#`, `**`, `[`/`]`) readable (dim grey, not near-black)
- the link destination `https://example.com/docs` readable (accent purple, not navy)
- `---` (thematic break) readable (accent purple)
- **default decorations survive**: `# Dark title` still bold + underlined, `**bold**` still bold — the guard against the fallback-replacement trap; if these render plain, the dark highlight style replaced the default without inheriting its specs
- `editor-md-flip-to-dark.png`: dark editor chrome WITHOUT a reload (the shot follows `emulateMedia` only)
- the remaining dark pairs (`*-dark.png`) differ from `before/` **only** in the editor region if at all (modulo the sidebar's minute-granular time labels, which may flip on wall-clock drift between runs) — the other surfaces were fixed in B18 and must not regress

- [ ] **Step 5: #65 computed-style probe**

Held-back suggestions are LLM-gated (`held_back` in the suggest response) — unreachable on the keyless scratch stack. Write and run `$SCRATCH/probe.mjs`:

```js
import { chromium } from '/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs'
import { globSync } from 'node:fs'

const exe = globSync(
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
).sort().reverse()[0]
const browser = await chromium.launch({ executablePath: exe })
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ colorScheme: theme })
  const p = await ctx.newPage()
  await p.goto('http://localhost:4199')
  await p.waitForSelector('.login-card')
  const probe = await p.evaluate(() => {
    const reason = document.createElement('p')
    reason.className = 'held-back-reason'
    document.body.appendChild(reason)
    return {
      reason: getComputedStyle(reason).color,
      token: getComputedStyle(document.documentElement)
        .getPropertyValue('--held-back')
        .trim(),
    }
  })
  console.log(theme, JSON.stringify(probe))
  await ctx.close()
}
await browser.close()
```

Run: `node $SCRATCH/probe.mjs` (with the `SCRATCH=` line first). Expected output, exactly:

```
light {"reason":"rgb(180, 83, 9)","token":"#b45309"}
dark {"reason":"rgb(245, 158, 11)","token":"#f59e0b"}
```

Both `.held-back-reason` and `.suggestion-button.held-back:hover` reference the same token, so the token + one resolved color covers both declarations (`:hover` cannot be computed-style-probed without a real pointer state).

- [ ] **Step 6: Tear down and restore production dist**

```bash
SCRATCH=/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/df-screens
kill $(cat $SCRATCH/backend.pid) $(cat $SCRATCH/preview.pid)
cd /Users/markus/IdeaProjects/fabulous-writing/frontend
npm run build
```

- [ ] **Step 7: Write `$SCRATCH/COMPARISON.md`**

Record: the light set result (byte-identical, 14 pairs), the dark checklist verdicts with one line of evidence each, the probe output verbatim, and any anomaly with its classification. Note that the `editor-md-*` and flip shots are element-scoped to `.editor-area` (no app chrome in frame) — the live-flip evidence is the editor's own restyle, not the surrounding chrome. No commit (scratch artifacts only) — the task report carries the verdict.

---

### Task 5: Architecture docs

**Files:**
- Modify: `docs/frontend-architecture.md`

**Interfaces:**
- Consumes: the shipped shapes from Tasks 2–3 (`--held-back`, `editorTheme`/`watchTheme`).
- Produces: nothing downstream.

- [ ] **Step 1: Extend the theme documentation**

In `docs/frontend-architecture.md`, in the "Theme root (B18, #63)" section: add `--held-back` to the token inventory (one line: both values, AA rationale, #65). Then add a short subsection after it:

```markdown
### Editor theming (#66)

CodeMirror does not follow `color-scheme`: its chrome is selected by the
`EditorView.darkTheme` facet, which `basicSetup` leaves false.
`src/editor/theme.ts` owns the fix: a `Compartment` that is empty in
light mode (light editor pixels are untouched) and in dark mode holds
two extensions. First, a `dark: true` theme — flipping the facet
activates CM's built-in dark chrome (caret, selection, active line stay
on those built-in values) and token-aligns the gutter
(`--panel`/`--text-dim`, active-line gutter `--bg-raised`; no border —
CM's dark base draws none). Second, a `themeType: 'dark'` highlight
style built from `defaultHighlightStyle.specs` with exactly two color
substitutions (`tags.meta` → `--text-dim`, the `tags.url` entry →
`--accent`): `basicSetup` registers the default style as a *fallback*,
which any main highlighter replaces wholesale — spreading the specs is
what keeps bold/italic/heading/link decorations alive in dark mode.
`watchTheme` follows live OS scheme changes via `matchMedia`;
`Editor.tsx` runs its cleanup on unmount. `@codemirror/language` and
`@lezer/highlight` became direct dependencies for
`HighlightStyle`/`syntaxHighlighting` and `tags`.
```

Adjust wording to fit the section's surrounding style; keep all technical claims exactly as above.

- [ ] **Step 2: Commit**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git add docs/frontend-architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): editor dark theming and --held-back token (#65, #66)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```
