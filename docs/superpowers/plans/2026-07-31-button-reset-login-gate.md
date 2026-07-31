# Button Font Consolidation (B11) + Split Login Gate (B4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the global button font reset (correcting #52's false premise), fix the one true button-size violation (ConfirmDialog), and rebuild the login gate as a split brand-pane layout with a localized tagline (#37).

**Architecture:** CSS-only consolidation in `index.css`/`App.css`; one shell component (`GateShell`) in `LoginGate.tsx` wraps all visible pre-auth states; a scripted Playwright screenshot sweep (scratch backend on :8001 + vite preview on :4199) provides before/after visual verification, since CSS carries no unit tests.

**Tech Stack:** React 19 / TypeScript / Vite; vitest + happy-dom; playwright-core (already in `frontend/node_modules`) for the sweep; scratch FastAPI backend via `uv`.

**Spec:** `docs/superpowers/specs/2026-07-31-button-reset-login-gate-design.md` — binding.

## Global Constraints

- Frontend gates before every commit: `npm test -- --run` green and `npm run build` clean, from `frontend/`.
- NEVER touch ports **5173/8000** (owner's dev servers) or `backend/data/fabulous.db`. The sweep uses **:8001/:4199** with a tempfile DB and kills only its own PIDs.
- Tagline strings are **owner-final** (spec lists all seven verbatim — transcribe exactly, no re-translation). de/es are deliberately imperative/informal, an intentional early adoption of B2's (#35) register.
- No specificity changes in the sweep: `.doc-menu-delete` and `.confirm-dialog-danger` colors must render identically (new rules set no `color`).
- No visual change outside the four intended ones (reset relocation is behavior-neutral; ConfirmDialog buttons 1rem → 0.85rem; login gate redesign; nothing else).
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

## File Structure

- Modify `frontend/src/index.css` — gains the global `input, select, button { font: inherit }` reset.
- Modify `frontend/src/App.css` — loses the reset + three dead `font: inherit` lines; two comment rewrites; `.confirm-dialog-buttons button` size; login-gate section rebuilt.
- Modify `frontend/src/auth/LoginGate.tsx` (new `GateShell`), `frontend/src/auth/LoginForm.tsx` (drops `Wordmark`).
- Modify all 7 catalogs `frontend/src/i18n/{en,de,fr,es,it,ja,zh}.ts` — `loginTagline`.
- Modify `frontend/src/auth/LoginGate.test.tsx` — two tagline tests.
- Modify `.gitignore`, `docs/frontend-architecture.md`; rewrite issue #52 via `gh`.
- Screenshot artifacts (not committed): `/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad/b11b4-screens/{before,after}/` plus the driver scripts in the same `b11b4-screens/` dir.

---

### Task 1: Baseline screenshot sweep (no code changes)

**Files:**
- Create (outside repo): `<scratchpad>/b11b4-screens/server.py`, `<scratchpad>/b11b4-screens/shoot.mjs`, `<scratchpad>/b11b4-screens/before/*.png` — where `<scratchpad>` = `/private/tmp/claude-501/-Users-markus-IdeaProjects-fabulous-writing/65c7f188-db68-4195-b05b-1819120fc3cc/scratchpad`

**Interfaces:**
- Produces: the two driver scripts Task 4 re-runs unchanged, and the `before/` PNG set Task 4 diffs against. **No commit** — this task changes nothing in the repo (the ledger records completion; there is no diff to review, the artifact set is the deliverable).

- [ ] **Step 1: Scratch backend on :8001**

Write `<scratchpad>/b11b4-screens/server.py`:

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

db = pathlib.Path(tempfile.mkdtemp(prefix="b11b4-")) / "scratch.db"
# cors override is REQUIRED: the default origins list is
# ["http://localhost:5173"], which would reject every browser fetch from
# the :4199 preview — the login just looks like a generic failure (curl
# can't catch this; it isn't subject to CORS). Same trap documented in
# docs/superpowers/plans/2026-07-25-multi-user-m2-enforcement.md.
app = create_app(Settings(db_path=db, cors={"origins": ["http://localhost:4199"]}))
uvicorn.run(app, host="127.0.0.1", port=8001)
```

Launch from `backend/`: `PYTHONPATH=/Users/markus/IdeaProjects/fabulous-writing/backend uv run python <scratchpad>/b11b4-screens/server.py` (background; record the PID). If the admin bootstrap needs more than the three env vars above, read `backend/app/main.py:85-200` and `backend/app/core/auth.py` and adapt `server.py`. Acceptance is two-level: (1) `curl -s http://127.0.0.1:8001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@scratch.local","password":"scratch-admin-pw-1"}'` returns a token, AND (2) the driver's own browser login reaches `.header` (Step 4 — this is what actually proves CORS).

- [ ] **Step 2: Frontend preview on :4199**

From `frontend/`: `VITE_API_URL=http://127.0.0.1:8001 npm run build`, then `grep -rl 8001 dist/assets | head -1` to confirm the API URL took, then `npx vite preview --port 4199 --strictPort` (background; record the PID). Drive `http://localhost:4199` (preview binds IPv6 — do not use 127.0.0.1).

- [ ] **Step 3: The shot list and driver**

Write `<scratchpad>/b11b4-screens/shoot.mjs`. Skeleton (playwright-core is imported by absolute path; the chromium executable is `~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell` — glob it, do NOT use `chrome-mac/headless_shell`):

```js
import { chromium } from '/Users/markus/IdeaProjects/fabulous-writing/frontend/node_modules/playwright-core/index.mjs'
import { globSync } from 'node:fs'

const OUT = process.argv[2]   // .../before or .../after
// Highest installed revision, not an arbitrary glob hit (1223 and 1228 are
// both installed; playwright-core pins a newer one). Better yet: reuse
// chromiumExecutable() from frontend/scripts/capture-screenshots.mjs:43-66,
// the repo's existing harness, which also fast-paths chromium.executablePath().
const exe = globSync(
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
).sort().reverse()[0]
const browser = await chromium.launch({ executablePath: exe })

async function page(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...opts,
  })
  const p = await ctx.newPage()
  await p.goto('http://localhost:4199')
  return p
}

async function login(p) {
  await p.fill('input[type=email]', 'admin@scratch.local')
  await p.fill('input[type=password]', 'scratch-admin-pw-1')
  await p.click('.login-submit')
  await p.waitForSelector('.header')
}

// 1-4: the gate, unauthenticated — both widths x both themes (spec)
for (const [name, opts] of [
  ['gate-light-wide', {}],
  ['gate-dark-wide', { colorScheme: 'dark' }],
  ['gate-light-narrow', { viewport: { width: 640, height: 900 } }],
  ['gate-dark-narrow', { colorScheme: 'dark', viewport: { width: 640, height: 900 } }],
]) {
  const g = await page(opts)
  // goto only waits for the load event, but LoginGate renders null until
  // its mount effect resolves the (absent) stored token to 'anonymous' —
  // an immediate screenshot can catch the blank restore state. .login-card
  // exists in both the current and the split layout: stable readiness signal.
  await g.waitForSelector('.login-card')
  await g.screenshot({ path: `${OUT}/${name}.png` })
}

// 5+: signed-in surfaces (class selectors only — UI locale varies)
const p = await page()
await login(p)
// Settle: .header appears while initDocuments and the provider/domain/
// language/routing/profile fetches are still in flight — pixel-stable
// before/after pairs need the async population to finish (the repo's
// capture-screenshots.mjs uses the same 600ms idiom).
await p.waitForSelector('.doc-list')
await p.waitForTimeout(600)
await p.screenshot({ path: `${OUT}/editor.png` })
// view switch: buttons in DOM order editor/rules/terminology/profiles(/admin)
for (const [i, name] of [[2, 'rules'], [3, 'terminology'], [4, 'profiles'], [5, 'admin']]) {
  await p.click(`.view-switch button:nth-child(${i})`)
  await p.waitForTimeout(600)
  await p.screenshot({ path: `${OUT}/${name}.png` })
}
// ...menus and dialogs: see instruction below
await browser.close()
```

Complete the `...menus and dialogs` part with this pinned choreography (all selectors verified against the components at plan time; the `.view-switch` buttons ARE its only children, so the nth-child indices above hold):

```js
// back to the editor view
await p.click('.view-switch button:nth-child(1)')
// account menu open
await p.click('.account-badge')
await p.waitForSelector('.account-menu')
await p.screenshot({ path: `${OUT}/account-menu.png` })
await p.keyboard.press('Escape')
// create a folder so folder-menu surfaces exist on the scratch DB:
// the new-folder control is the FIRST .doc-sidebar-toggle in the head row
await p.click('.doc-sidebar-head .doc-sidebar-toggle')
await p.fill('.doc-sidebar input', 'Sweep')
await p.keyboard.press('Enter')
await p.waitForSelector('.folder-head')
// folder ... menu open (popover class .doc-menu, same idiom as doc rows).
// HOVER FIRST, both times: .folder-head .doc-menu-button is
// visibility: hidden until .folder-head:hover (App.css ~1766), and
// Playwright's actionability check refuses hidden targets before it
// ever moves the mouse (same idiom in capture-screenshots.mjs:300-301).
await p.hover('.folder-head')
await p.click('.folder-head .doc-menu-button')
await p.waitForSelector('.doc-menu')
await p.screenshot({ path: `${OUT}/doc-menu.png` })
// folder menu item order: new-document(1), defaults(2), rename(3), delete(4)
await p.click('.doc-menu button:nth-child(2)')
await p.waitForSelector('.folder-defaults-dialog')
await p.waitForTimeout(600)   // profile-list fetch settles the selects
await p.screenshot({ path: `${OUT}/folder-defaults.png` })
await p.keyboard.press('Escape')
// confirm dialog via the folder's delete item (Cancel it afterwards)
await p.hover('.folder-head')
await p.click('.folder-head .doc-menu-button')
await p.click('.doc-menu-delete')
await p.waitForSelector('.confirm-dialog')
await p.screenshot({ path: `${OUT}/confirm-dialog.png` })
await p.keyboard.press('Escape')
```

- [ ] **Step 4: Capture the baseline**

`mkdir -p <scratchpad>/b11b4-screens/before && node <scratchpad>/b11b4-screens/shoot.mjs <scratchpad>/b11b4-screens/before`
Expected: 13 PNGs (4 gate + 5 views + 4 menus/dialogs). Open `confirm-dialog.png` and confirm the two dialog buttons visibly render larger than the 0.85rem message text — that is the defect Task 2 fixes, and the baseline must show it.

- [ ] **Step 5: Teardown**

Kill the two recorded PIDs; verify :8001 and :4199 are free (`lsof -i :8001 -i :4199`); from `frontend/` run a plain `npm run build` to restore the production `dist/`. Report the artifact inventory (file names + byte sizes).

---

### Task 2: B11 — reset consolidation, ConfirmDialog size fix, .gitignore

**Files:**
- Modify: `frontend/src/index.css` (after the `* { box-sizing }` rule)
- Modify: `frontend/src/App.css:1059-1063`, `~1126-1139`, `~1688-1700`, `~1825-1844`, `~2018-2028`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing. Produces: the final CSS state Task 4 verifies visually.

CSS has no unit-test cycle; the gates are the suite (unchanged behavior), the build, and Task 4's sweep. Line numbers are from the planning snapshot — locate by quoted text.

- [ ] **Step 1: Move the global reset to `index.css`**

In `frontend/src/index.css`, directly after the `* { box-sizing: border-box; }` block, add:

```css
/* Form controls inherit the app font instead of UA defaults. Global home
   for the reset (B11, #52): index.css loads first, independent of
   App.css's import timing. Surfaces that need a size other than their
   parent's set font-size on their own class — never a second element-
   level rule. */
input,
select,
button {
  font: inherit;
}
```

In `frontend/src/App.css`, delete the now-duplicate block (currently at 1059-1063):

```css
input,
select,
button {
  font: inherit;
}
```

(The `input { padding: 0.3rem 0.5rem; ... }` rule that follows it stays.)

- [ ] **Step 2: Delete the three dead `font: inherit` lines**

1. `.rules-group h3 .rules-collapse` (~1135): delete only the `font: inherit;` line — `color: inherit`, `letter-spacing: inherit`, `text-transform: inherit` stay (the global reset does not cover them).
2. `.doc-menu button` (~1694-1699): delete the `font: inherit;` line and replace the comment
   ```css
   /* No global button reset exists, so without this the items render in
      the UA's default button font — larger and off-family. No `color`
      here: .doc-menu-delete's danger red has lower specificity and must
      keep winning. */
   ```
   with
   ```css
   /* The global reset (index.css) makes buttons inherit the app font;
      this pins the menu's 0.85rem size (unsized buttons would inherit
      the root 1rem here). No `color`: .doc-menu-delete's danger red has
      lower specificity and must keep winning. */
   ```
   keeping `font-size: 0.85rem;`.
3. `.account-menu > button` (~2024-2027): delete the `font: inherit;` line and replace
   ```css
   /* Same UA-default-font fix as .doc-menu button (the recipe this was
      copied from). */
   ```
   with
   ```css
   /* Same 0.85rem size pin as .doc-menu button (the recipe this was
      copied from). */
   ```
   keeping `font-size: 0.85rem;`.

- [ ] **Step 3: ConfirmDialog button size (the sweep's one fix)**

In `frontend/src/App.css`, extend the `.confirm-dialog-buttons` group (after the existing rule at ~1832-1836):

```css
/* Unsized buttons inherit the root 1rem here (no sized ancestor inside
   dialog.app-dialog); match the dialog's 0.85rem body text. No `color`
   or other properties: .confirm-dialog-danger must win unchanged. */
.confirm-dialog-buttons button {
  font-size: 0.85rem;
}
```

- [ ] **Step 4: `.gitignore`**

Verify the line `.superpowers/` is present in the repo-root `.gitignore` (it was added on the planning branch after brainstorm scratch got swept into a `git add -A`); add it only if missing.

- [ ] **Step 5: Gates**

From `frontend/`: `npm test -- --run` → all green (no test asserts fonts); `npm run build` → clean. Also `git -C .. check-ignore .superpowers/ && echo IGNORED` → `IGNORED` (run from `frontend/`, or equivalently from the repo root without the `-C ..`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/index.css frontend/src/App.css .gitignore
git commit -m "style(ui): consolidate global button font reset; size ConfirmDialog buttons (B11, #52)"
```
(with the two mandatory trailer lines)

---

### Task 3: B4 — split login gate with tagline

**Files:**
- Modify: `frontend/src/auth/LoginGate.tsx`, `frontend/src/auth/LoginForm.tsx`, `frontend/src/Wordmark.tsx` (stale header comment)
- Modify: `frontend/src/App.css` (login-gate section, currently ~1917-1967)
- Modify: `frontend/src/i18n/en.ts`, `de.ts`, `fr.ts`, `es.ts`, `it.ts`, `ja.ts`, `zh.ts`
- Test: `frontend/src/auth/LoginGate.test.tsx`

**Interfaces:**
- Consumes: Task 2's final CSS state (no dependency on its content, only ordering — one shared file).
- Produces: `.login-split` / `.login-brand` / `.login-tagline` / `.login-pane` class names Task 4's gate shots exercise; i18n key `loginTagline`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/auth/LoginGate.test.tsx`, add two tests inside the file's existing describe structure (the file already imports `en`, `useStore`, `render`, `screen`, `waitFor` and mocks `getMe`; `Sentinel` is its existing helper — place these next to the existing anonymous-state and connection-failed tests, whose seeding they copy):

```tsx
  it('renders the brand tagline on the anonymous gate (B4)', () => {
    useStore.setState({ authStatus: 'anonymous' })
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    screen.getByText(en.loginTagline)
  })

  it('renders the brand tagline on the connection-failed gate (B4)', async () => {
    // A stored token whose restore rejects with a network error (not a
    // 401) sets restoreFailed via runRestore()'s non-401 branch — the
    // gate then renders the connection-failed card inside the shell.
    useStore.setState({ token: 'tok', authStatus: 'unknown' })
    vi.mocked(getMe).mockRejectedValue(new TypeError('offline'))
    render(
      <LoginGate>
        <Sentinel />
      </LoginGate>,
    )
    await waitFor(() => screen.getByText(en.connectionFailed))
    screen.getByText(en.loginTagline)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/auth/LoginGate.test.tsx`
Expected: the two new tests FAIL (`loginTagline` key does not exist / text not rendered); TypeScript may already fail on the missing catalog key — that counts as the expected failure.

- [ ] **Step 3: Add the tagline key to all 7 catalogs**

Place alphabetically-adjacent to the existing `signIn*` keys in each file, matching each catalog's quoting style. The strings are **owner-final** (reviewed by Markus 2026-07-31) — transcribe them exactly as written, do not re-translate or "improve":

- `en.ts`: `loginTagline: 'Write clearly. Get checked, not judged.',`
- `de.ts`: `loginTagline: 'Schreib klar. Geprüft, nicht bewertet.',`
- `fr.ts`: `loginTagline: 'Écrire clairement. Être relu, pas jugé.',`
- `es.ts`: `loginTagline: 'Escribe claro. Te revisamos, no te juzgamos.',`
- `it.ts`: `loginTagline: 'Scrivi chiaro. Revisione, non giudizio.',`
- `ja.ts`: `loginTagline: '明快に書く。評価ではなく、確認を。',`
- `zh.ts`: `loginTagline: '写得清楚。只检查，不评判。',`

(de/es are deliberately imperative/informal — B2's register, adopted early for this one string by owner decision.)

Add the key to the `Messages` interface in `frontend/src/i18n/messages.ts` wherever the `signIn*` members live (same neighborhood). The catalog-parity test (`i18n.test.ts`) enforces completeness — do not touch it.

- [ ] **Step 4: Rebuild the gate markup**

`frontend/src/auth/LoginGate.tsx` — add the shell and use it for both visible pre-auth states. Preserve the existing comments verbatim (the mount-effect dedup comment, the `role="alert"` comment, the trailing 'unknown'-state comment); the four-state branching is unchanged:

```tsx
import { useEffect, type ReactNode } from 'react'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { Wordmark } from '../Wordmark'
import { LoginForm } from './LoginForm'
import { restoreSession } from './session'

/** Split shell shared by every visible pre-auth state (B4, #37): brand
 * pane (wordmark + tagline) beside the pane content. The gate's state
 * branching stays in LoginGate — this is layout only. */
function GateShell({ children }: { children: ReactNode }) {
  const m = useMessages()
  return (
    <div className="login-gate">
      <div className="login-split">
        <div className="login-brand">
          <Wordmark />
          <p className="login-tagline">{m.loginTagline}</p>
        </div>
        <div className="login-pane">{children}</div>
      </div>
    </div>
  )
}
```

The `restoreFailed` branch returns the same card minus its `<Wordmark />`, wrapped in the shell:

```tsx
  if (restoreFailed) {
    return (
      <GateShell>
        <div className="login-card">
          {/* (keep the existing role="alert" comment here) */}
          <p className="llm-error" role="alert">
            {m.connectionFailed}
          </p>
          <button
            type="button"
            className="login-submit"
            onClick={() => void restoreSession()}
          >
            {m.connectionRetry}
          </button>
        </div>
      </GateShell>
    )
  }
```

The anonymous branch becomes:

```tsx
  if (authStatus === 'anonymous') {
    return (
      <GateShell>
        <LoginForm />
      </GateShell>
    )
  }
```

`frontend/src/auth/LoginForm.tsx`: remove the `import { Wordmark } from '../Wordmark'` line and the `<Wordmark />` element (first child of the form). Everything else — fields, notice slot and its comments, submit button — is byte-identical.

- [ ] **Step 5: Rebuild the login-gate CSS section**

In `frontend/src/App.css`, in the `/* ---- login gate ---- */` section: in `.login-gate`, change `height: 100vh;` to `min-height: 100vh;` (identical rendering while content fits the viewport, but the stacked shell — already ~330px before an expiry/error notice — scrolls instead of clipping on short mobile/landscape viewports; the 640×900 screenshot cannot catch clipping, so this is a code-level guard, not a sweep-verified one); **delete** the `.login-card .wordmark` rule (the card no longer contains the wordmark); keep `.login-card`, `.login-field`, `.login-field input`, `.login-submit` untouched (`.login-field` is shared with the change-password dialog); and add after `.login-gate`:

```css
/* B4 (#37) split shell: brand pane beside the form pane at >=720px,
   stacked below. Existing tokens only — light and dark both work with
   no theme-specific rules. */
.login-split {
  display: flex;
  align-items: stretch;
  width: min(52rem, 100%);
}

.login-brand {
  flex: 1.2;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.6rem;
  padding: 2.5rem;
  background: linear-gradient(135deg, var(--accent-soft), transparent 70%);
  border-radius: 12px 0 0 12px;
}

.login-brand .wordmark {
  font-size: 2rem;
  font-weight: 700;
}

.login-tagline {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.9rem;
}

.login-pane {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1.5rem;
}

@media (max-width: 719px) {
  .login-split {
    flex-direction: column;
    align-items: center;
  }
  .login-brand {
    align-items: center;
    text-align: center;
    padding: 1.5rem 1.5rem 0.75rem;
    /* The spec's accent wash stays in the stacked layout too — only the
       gradient's corner rounding adapts to the pane now sitting on top. */
    background: linear-gradient(180deg, var(--accent-soft), transparent 85%);
    border-radius: 12px 12px 0 0;
  }
  .login-brand .wordmark {
    font-size: 1.5rem;
  }
}
```

Two comments elsewhere describe the wordmark living in the login *card* and go stale with this relocation — update both: (a) `App.css` ~23-26 ("Shared by Header() and LoginForm/LoginGate's card…") → say the sharing is now between the header and the gate's brand pane; (b) `frontend/src/Wordmark.tsx`'s header comment ("…so LoginForm's card can use the exact same markup") → same correction (the gate's brand pane, not the card).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --run src/auth/LoginGate.test.tsx src/i18n` — the two new tests and the catalog-parity test PASS.

- [ ] **Step 7: Full gates**

From `frontend/`: `npm test -- --run` all green (the existing gate tests query by role/name and must pass unchanged — if one fails, the markup change broke a contract; fix the markup, not the test); `npm run build` clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/auth/LoginGate.tsx frontend/src/auth/LoginForm.tsx frontend/src/Wordmark.tsx frontend/src/App.css frontend/src/i18n frontend/src/auth/LoginGate.test.tsx
git commit -m "feat(auth): split login gate — brand pane with localized tagline (B4, #37)"
```
(with the two mandatory trailer lines)

---

### Task 4: After-sweep and visual comparison

**Files:**
- Create (outside repo): `<scratchpad>/b11b4-screens/after/*.png`, `<scratchpad>/b11b4-screens/COMPARISON.md`

**Interfaces:**
- Consumes: Task 1's `server.py` + `shoot.mjs` unchanged, and its `before/` set. **No commit** (ledger records completion; the comparison report is the deliverable).

- [ ] **Step 1: Re-run the stack and capture**

Repeat Task 1's Steps 1-2 (same commands; the frontend build now contains Tasks 2-3), then `mkdir -p <scratchpad>/b11b4-screens/after && node <scratchpad>/b11b4-screens/shoot.mjs <scratchpad>/b11b4-screens/after`. The four gate shots will differ by design — the driver needs no changes (it targets `input[type=email]`/`.login-submit`, which survive the redesign).

- [ ] **Step 2: Compare, shot by shot**

Write `<scratchpad>/b11b4-screens/COMPARISON.md`: for each of the 13 pairs, one line — `identical`, `intended diff: <what>`, or `UNINTENDED: <what>`. Expected intended diffs, exactly these:
- `gate-*.png` (4): the split/stacked redesign with tagline.
- `confirm-dialog.png`: the two dialog buttons smaller (1rem → 0.85rem).
- Every other pair (`editor`, `rules`, `terminology`, `profiles`, `admin`, `account-menu`, `doc-menu`, `folder-defaults`): **pixel-identical** (byte-compare with `cmp -s` first; where `cmp` differs, eyeball for rendering jitter vs. real change — anti-aliasing noise from a rebuilt bundle is acceptable, any size/layout shift is not).

Any `UNINTENDED` finding: STOP, report it — do not adjust CSS to make it pass.

- [ ] **Step 3: Teardown and report**

Task 1's Step 5 teardown (kill own PIDs, verify ports free, plain `npm run build`). Report the comparison table verbatim in your report file.

---

### Task 5: Bookkeeping — issue #52 rewrite, architecture doc

**Files:**
- Modify: `docs/frontend-architecture.md`
- External: issue #52 body via `gh`

**Interfaces:** consumes the shipped state of Tasks 2-3; nothing consumes this task.

- [ ] **Step 1: Rewrite issue #52**

`gh issue edit 52 --repo saigyo/fabulous-writing --body-file <file>` with this body:

```markdown
**Corrected diagnosis (2026-07-31, supersedes the original text below the rule):** the app has had a global `input, select, button { font: inherit }` reset since the first frontend commit (2026-07-03). The B3-era symptom was a **font-size** bug — unsized buttons inherit the root 1rem inside smaller-text surfaces — not a missing reset. Resolved by the B11 half of `docs/superpowers/specs/2026-07-31-button-reset-login-gate-design.md`: the reset moved to `index.css` as its single global home, the dead duplicate `font: inherit` declarations and their false comments were removed, all unsized-button candidates were audited under the inheritance model (one true violation: ConfirmDialog's buttons, fixed to 0.85rem), and a before/after screenshot sweep of every surface verified no unintended shifts.

---

*Original text (premise corrected above):*

<original body verbatim>
```

Fetch the original body first (`gh issue view 52 --json body`) and splice it in verbatim where marked.

- [ ] **Step 2: Architecture doc**

In `docs/frontend-architecture.md`: (a) wherever the login gate/card is described, update to the split shell (brand pane with wordmark + `loginTagline`, form pane hosting the unchanged card, 720px stacking breakpoint, all pre-auth states share the shell); (b) if the button reset or `index.css` contents are described anywhere (`grep -n "box-sizing\|font: inherit\|index.css" docs/frontend-architecture.md`), reflect that `index.css` now owns the form-control font reset. Match the document's prose style.

- [ ] **Step 3: Gates and commit**

From `frontend/`: `npm test -- --run` and `npm run build` (unchanged code — confirms a clean tree).

```bash
git add docs/frontend-architecture.md
git commit -m "docs(frontend): split login gate and index.css button reset (B11+B4, #52, #37)"
```
(with the two mandatory trailer lines)
