# B43 C2: Chromium Browser Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the MV3 Chromium extension MVP — scout content script, textarea
adapter (lifted from the C1 simulator), mirror-overlay markings, side-panel host
with the embed iframe + relay, options page, pinned manifest key — plus the three
C2 checklist items that live server/frontend-side: IPv6 bracket-literal support in
`embed.allowed_ancestors`, embed language persistence, and the fly-config
allowlist entry with its CI cross-pin guard.

**Architecture:** The extension is a new self-contained npm package at
`clients/browser-extension/` that imports the shared protocol module and the
reference `TextareaAdapter` **directly from `frontend/src/` by relative path**
(no copies — a breaking protocol change fails the extension's compile, which is
the spec's stated point of the shared module). Three browser contexts speak
through `browser.runtime` ports: the **scout** content script (field detection by
event delegation, shadow-DOM affordance, adapter session) ↔ the **service
worker** (per-window connection registry, message routing, badge) ↔ the **panel
page** (embed iframe, hello loop, postMessage relay). Protocol envelopes pass
through the service worker untranslated; a small `ctl:` message family handles
extension-internal lifecycle.

**Tech Stack:** MV3, TypeScript, Vite (two build passes: ESM for sw/panel/
options, single-file IIFE for the content script), `webextension-polyfill`,
vitest + happy-dom, oxlint, Playwright (`playwright-core`, local-only e2e).
Backend work: FastAPI/pydantic settings + pytest.

**Spec:** `docs/superpowers/specs/2026-08-22-b43-embeddable-clients-design.md`
(read the amendment blocks — several protocol details changed during C1).
Umbrella issue: #134 (C2 checkbox + the 2026-08-23 checklist-additions comment).

## Global Constraints

- Never read or write `backend/data/` (live DB). Backend tests always build
  `Settings` against `tmp_path`. The e2e harness uses its own tmp dir + port.
- Never kill, restart, or start anything on ports **5173** and **8000** (the
  owner's dev servers). The e2e backend uses **8100**, its fixture server **8101**.
- Secrets: names may appear, values never. The manifest `key` is a PUBLIC key —
  committing it is correct; no private-key material is ever committed or printed.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01JXiCFTQQmJeJt3MB8qZdGA`.
- Gates: backend `rtk proxy uv run pytest -q` from `backend/` green with ZERO
  warnings; frontend `npm run test`, `rtk proxy npm run lint`, `npm run build`,
  `npm run check:embed`; extension (from `clients/browser-extension/`)
  `npm run lint`, `npm test`, `npm run build`. Mutation-verify every guard test
  (delete the guard, watch the test fail, restore by re-editing — never
  `git checkout <file>`).
- Spec rules carried into every task: `webextension-polyfill` everywhere; **no
  Chromium-only API outside `src/panelHost.ts` and the manifest**; no token or
  credential ever crosses the bridge; offsets are UTF-16 code units; protocol
  module (`frontend/src/embed/protocol.ts`) is **not modified** in this slice.
- The shared-source rule cuts both ways: files under `frontend/src/` imported by
  the extension (`embed/protocol.ts`, `simulator/textareaAdapter.ts`,
  `simulator/clickHitTest.ts`, `findings/severity.ts`, `types.ts`) are modified
  only with the frontend gates re-run. The ONLY shared file this plan changes is
  `simulator/textareaAdapter.ts` (Task 6's host-page integration — the adapter
  was written as the C2 blueprint and the change keeps the simulator's behavior
  identical); `protocol.ts` stays untouched.
- UI copy: informal register (Du/tu/tú) per `register.test.ts` conventions —
  the extension's own strings are English-only in v1 (the embed inside the
  iframe is fully localized already); keep them terse and informal.
- Branch: `b43-c2-extension` off `main`. PR per house workflow (Copilot review,
  Markus merges). Do not close #134 — tick its C2 checkbox in the PR body text
  (`Part of #134`), never `Closes`.

### Design rulings baked into this plan (deviations from the spec's letter)

1. **No lazy adapter chunk.** The spec says "Adapter code loads lazily on
   connect." Dynamic `import()` from a content script is subject to the *page's*
   CSP in Chromium (long-standing platform issue), and the acceptance benchmark
   — GitHub — ships a strict CSP. The scout, session, and adapter therefore
   build into **one IIFE** (~20 KB min) with no runtime loading at all. This
   also empties `web_accessible_resources`, which is a fingerprinting win.
2. **Detection by event delegation, MutationObserver only for removal.** The
   spec names a MutationObserver for detection (GitHub Turbo). Delegated
   `focusin`/`mouseover` listeners on the document detect any field the moment
   the user can interact with it — Turbo-injected fields included — with zero
   scanning. A MutationObserver watches only the *connected* element for DOM
   removal (auto-disconnect). Same observable behavior, strictly less work.
3. **Panel header = embed connection strip.** The spec's "panel header names the
   connected page/field" is satisfied by the embed's existing
   `embed-connection-strip` (shows the connected page URL). The panel adds only
   a minimal chrome: title + options link.

---

## File Structure

```
clients/browser-extension/
  package.json               npm package (own lockfile), scripts, pinned deps
  tsconfig.json              noEmit typecheck incl. the imported frontend sources
  vite.config.ts             ESM build: sw, panel, options (stable filenames)
  vite.content.config.ts     IIFE build: scout single file
  public/
    manifest.json            MV3 manifest, pinned "key"
    icons/{16,32,48,128}.png generated placeholder icons (scripts/make-icons.mjs)
  vitest.setup.ts            global browser mock wiring (webextension-polyfill)
  panel.html                 side-panel page (also openable as a tab — e2e)
  options.html               options page
  src/
    messages.ts              ctl-message types + port envelope (relay|ctl)
    settings.ts              server-URL storage (browser.storage.local)
    registry.ts              PURE per-window connection registry -> effects
    sw.ts                    service worker: ports, routing, badge
    panelHost.ts             the ONLY Chromium-only module (chrome.sidePanel)
    panel.ts                 panel page wiring (iframe, port, hello loop)
    relay.ts                 PURE relay core (hello loop, parse, forward)
    options.ts               options page logic
    testing/browserMock.ts   in-memory browser.* mock (storage, runtime, windows)
    detect.ts                PURE field eligibility predicate
    affordance.ts            shadow-DOM connect chip
    session.ts               adapter session: protocol host role for one field
    scout.ts                 content-script entry: delegation + wiring
    marks.css.ts             mark colors as an exported string (injected <style>)
  src/*.test.ts              vitest suites beside their modules
  e2e/
    fixture.html             local test page with a plain <textarea>
    run.mjs                  boots backend(8100)+fixture(8101), runs the spec
    extension.spec.mjs       Playwright flow (connect->login->findings->apply)
  scripts/
    extension-id.mjs         derives the extension ID from the manifest key
    make-icons.mjs           writes the placeholder PNG icon set
  README.md                  pointer to docs/browser-extension.md
.github/workflows/extension.yml   lint+test+build CI (paths incl. shared frontend srcs)
backend/app/core/config.py        IPv6 bracket literals in allowed_ancestors
backend/tests/test_config.py      validator tests
backend/tests/test_fly_config.py  cross-pin guard: fly allowlist == manifest ID
deploy/fly/config.yaml            embed.allowed_ancestors entry
backend/config.example.yaml       IPv6 note update
frontend/src/state/prefsStorage.ts       Prefs.language
frontend/src/state/prefsPersistence.ts   defaults + pick
frontend/src/simulator/textareaAdapter.ts  host-page integration (Task 6 A)
docs/browser-extension.md         install/dev/e2e/acceptance checklist
docs/{frontend,backend}-architecture.md  updates
```

---

### Task 1: Backend — IPv6 bracket literals in `embed.allowed_ancestors`

C1's closing review documented that `EmbedSettings._validate_entries` cannot
accept `http://[::1]:8000`-style origins. Add bracket-literal support.

**Files:**
- Modify: `backend/app/core/config.py` (the `is_valid_origin` closure inside
  `_validate_entries`, currently around lines 263-300)
- Modify: `backend/config.example.yaml` (the `embed:` doc block, ~line 126)
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Consumes: existing `EmbedSettings` validator.
- Produces: `embed.allowed_ancestors` accepts `scheme://[<IPv6>]` and
  `scheme://[<IPv6>]:<port>`; everything previously valid stays valid;
  everything previously invalid (other than bracket literals) stays invalid.

- [ ] **Step 1: Write the failing tests**

Find the existing `allowed_ancestors` tests in `backend/tests/test_config.py`
(search for `allowed_ancestors`) and add new tests **in that suite's own idiom**
— it constructs via `Settings.model_validate({"embed": {...}})` and asserts
rejections with `pytest.raises(ValidationError, match="allowed_ancestors")`;
mirror that exactly:

```python
def test_ipv6_bracket_literal_accepted(self):
    settings = Settings.model_validate(
        {"embed": {"allowed_ancestors": ["http://[::1]:8000"]}}
    )
    assert settings.embed.allowed_ancestors == ["http://[::1]:8000"]

def test_ipv6_bracket_literal_without_port_accepted(self):
    settings = Settings.model_validate(
        {"embed": {"allowed_ancestors": ["https://[2001:db8::1]"]}}
    )
    assert settings.embed.allowed_ancestors == ["https://[2001:db8::1]"]

@pytest.mark.parametrize(
    "entry",
    [
        "http://[::1",           # unclosed bracket
        "http://[not-an-ip]",    # not an IPv6 literal
        "http://[::1]x",         # trailing junk after the bracket
        "http://[::1]:99999",    # port out of range
        "http://[::1]:١٢٣",      # non-ASCII digits (same guard as hostnames)
        "http://[]",             # empty literal
        "http://[1.2.3.4]",      # IPv4 in brackets is not an IPv6 literal
        "http://[fe80::1%eth0]", # zone ID — can never match an Origin header
    ],
)
def test_ipv6_bracket_literal_rejected(self, entry):
    with pytest.raises(ValidationError, match="allowed_ancestors"):
        Settings.model_validate({"embed": {"allowed_ancestors": [entry]}})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run (from `backend/`): `rtk proxy uv run pytest tests/test_config.py -q`
Expected: the two accept-tests FAIL with `ValidationError` (bracket entries
currently rejected); the reject-tests may already pass — that is fine.

- [ ] **Step 3: Implement**

In `config.py`, add `import ipaddress` to the module imports if absent. Inside
`_validate_entries`, extract the existing inline port check into a local helper
and add the bracket branch at the top of `is_valid_origin`'s host handling:

```python
        def is_valid_port(port: str) -> bool:
            # isascii() first: str.isdigit() accepts non-ASCII decimal digits
            # (e.g. Arabic-Indic), which int() parses — see the hostname-port
            # comment below; same rule here.
            return port.isascii() and port.isdigit() and 1 <= int(port) <= 65535

        def is_valid_origin(entry: str) -> bool:
            scheme, sep, rest = entry.partition("://")
            if not sep or not scheme_pattern.fullmatch(scheme) or not rest:
                return False
            if rest.startswith("["):
                # IPv6 bracket literal (C2, #134): [<literal>] with an
                # optional :port. IPv6Address does the real validation
                # (rejecting IPv4-in-brackets and non-address strings) —
                # EXCEPT zone IDs (fe80::1%eth0), which it accepts since
                # Python 3.9 but which can never match a real Origin
                # header, so reject '%' explicitly first.
                literal, bracket, tail = rest[1:].partition("]")
                if not bracket or "%" in literal:
                    return False
                try:
                    ipaddress.IPv6Address(literal)
                except ValueError:
                    return False
                if tail == "":
                    return True
                return tail.startswith(":") and is_valid_port(tail[1:])
            if ":" in rest:
                host, _, port = rest.rpartition(":")
                if not is_valid_port(port):
                    return False
            else:
                host = rest
            if not host:
                return False
            return all(label_pattern.fullmatch(label) for label in host.split("."))
```

Keep the existing explanatory comments (move the non-ASCII-digit comment onto
`is_valid_port`). In `config.example.yaml`, the `embed:` block's comment
currently says "no IPv6 literals (yet)" — **remove that clause** and document
the bracketed form instead (`http://[::1]:8000`; zone IDs rejected).
(`docs/backend-architecture.md` carries the same "(yet)" clause — Task 12
updates it; keep the wording in sync.)

- [ ] **Step 4: Run the backend suite**

Run: `rtk proxy uv run pytest -q` (from `backend/`)
Expected: PASS, zero warnings.

- [ ] **Step 5: Mutation-verify**

Temporarily replace the `ipaddress.IPv6Address(literal)` call's `except
ValueError: return False` with `except ValueError: pass` — the
`not-an-ip` test must fail. Restore by re-editing. Then temporarily drop the
`tail.startswith(":")` check — the trailing-junk test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add backend/app/core/config.py backend/tests/test_config.py backend/config.example.yaml
git commit -m "feat(embed): accept IPv6 bracket literals in embed.allowed_ancestors (B43 C2)"
```

---

### Task 2: Frontend — persist the check language

The embed loses its language selection on every panel reload (the main app
recovers it from the open document; the embed has no document — #134 comment).
Fix at the shared prefs layer: `language` becomes the seventh persisted pref.
The main app benefits too (language restored when no document hydrates); doc
hydration still runs after `loadUserPrefs` and overwrites `language`. One
main-app interaction IS affected and must be pinned by tests: `hydration.ts`
arms `setProfileApplySuppressed(doc.language !== store.language)` — a persisted
language different from the opened document's now arms suppression where the
`'en'` default previously might not have. That is the suppression path working
as designed, but it needs explicit coverage (Step 1's last two tests).

**Files:**
- Modify: `frontend/src/state/prefsStorage.ts`
- Modify: `frontend/src/state/prefsPersistence.ts`
- Test: `frontend/src/state/prefsStorage.test.ts`,
  `frontend/src/state/prefsPersistence.test.ts` (extend the existing suites)

**Interfaces:**
- Consumes: `Language` from `../types`, `INITIAL_DATA.language` (`'en'`),
  `store.setLanguage`.
- Produces: `Prefs.language: Language`; `PREF_KEYS` includes `'language'`.
  `PREFS_VERSION` stays 2 — the change is additive; old blobs simply lack the
  key and the default applies (readPrefs already drops missing/invalid keys).

- [ ] **Step 1: Write the failing tests**

In `prefsStorage.test.ts` (follow the existing per-field validator tests; for
the round-trip reuse the suite's existing full-`Prefs` fixture — extend it with
`language` since `writePrefs` requires a complete `Prefs`):

```ts
it('round-trips language', () => {
  writePrefs(7, { ...fullPrefsFixture, language: 'de' })
  expect(readPrefs(7)).toMatchObject({ language: 'de' })
})

it('drops an invalid language value', () => {
  localStorage.setItem(
    prefsKey(7),
    JSON.stringify({ version: 2, state: { language: 'klingon' } }),
  )
  expect(readPrefs(7)).not.toHaveProperty('language')
})
```

In `prefsPersistence.test.ts`:

```ts
it('applies a persisted language at login and defaults without one', () => {
  writePrefs(7, { ...PREFS_DEFAULTS, language: 'fr' })
  loadUserPrefs(7)
  expect(useStore.getState().language).toBe('fr')
  loadUserPrefs(8) // no blob -> default
  expect(useStore.getState().language).toBe('en')
})

it('writes language changes while logged in', () => {
  // arrange per the suite's existing logged-in write test, then:
  useStore.getState().setLanguage('it')
  expect(readPrefs(userId)).toMatchObject({ language: 'it' })
})
```

And in the hydration suite (`frontend/src/documents/` tests — find the existing
open-document hydration tests and extend beside them), pin the suppression
interaction named in the preamble:

```ts
it('doc language differing from persisted language keeps the doc profile', () => {
  // persisted language 'de', hydrate a doc { language: 'en', profile_id: 5 }
  // -> store.language 'en', profile selection 5 (the doc's own), suppression
  //    consumed without clobbering it
})

it('doc language differing from persisted language, doc without profile', () => {
  // persisted 'de', hydrate { language: 'en', profile_id: null }
  // -> assert the selector state applyHeaderProfileSelection's early-return
  //    branch produces (read profileApply.ts first; pin what it does today)
})
```

- [ ] **Step 2: Run to verify failure**

Run (from `frontend/`): `npm test -- src/state`
Expected: FAIL — `language` is not persisted/read.

- [ ] **Step 3: Implement**

`prefsStorage.ts`: add `language: Language` to `Prefs` (import
`type Language` from `../types`); add `'language'` to `PREF_KEYS`; add the
validator — the seven codes are a fixed contract, so declare them locally as
part of the storage schema rather than importing the UI catalog:

```ts
const LANGUAGE_CODES = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh'] as const

// in VALIDATORS:
  language: (v): v is Language =>
    typeof v === 'string' && (LANGUAGE_CODES as readonly string[]).includes(v),
```

`prefsPersistence.ts`: `PREFS_DEFAULTS` gains
`language: INITIAL_DATA.language`; `pick` gains `language: state.language`;
its doc comment "The six persisted fields" becomes "The seven persisted
fields".

- [ ] **Step 4: Run the frontend gates**

Run: `npm test`, `rtk proxy npm run lint`, `npm run build`, `npm run check:embed`
Expected: all green — in particular the existing hydration/session suites must
stay green (they prove doc hydration still overrides the persisted language).

- [ ] **Step 5: Mutation-verify**

Remove `'language'` from `PREF_KEYS` — the round-trip and login tests must
fail. Restore by re-editing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/prefsStorage.ts frontend/src/state/prefsPersistence.ts \
  frontend/src/state/prefsStorage.test.ts frontend/src/state/prefsPersistence.test.ts
git commit -m "feat(embed): persist check language across reloads (B43 C2)"
```

---

### Task 3: Extension package scaffold, manifest with pinned key, CI

**Files:**
- Create: `clients/browser-extension/package.json`, `tsconfig.json`,
  `vite.config.ts`, `vite.content.config.ts`, `public/manifest.json`,
  `panel.html`, `options.html`, `.gitignore`, `README.md`,
  `scripts/extension-id.mjs`, placeholder entries `src/sw.ts`, `src/panel.ts`,
  `src/options.ts`, `src/scout.ts` (each a one-line `export {}` +
  `console.debug('fw: <name> loaded')` so the build has real inputs)
- Create: `.github/workflows/extension.yml`

**Interfaces:**
- Produces: a `dist/` that Chromium loads unpacked without errors; the stable
  extension ID (from the pinned key) printed by `node scripts/extension-id.mjs`;
  npm scripts `lint`, `test`, `build` as gates for every later task.

- [ ] **Step 1: Generate the key pair and derive the ID**

```bash
cd clients/browser-extension
KEYFILE="$(mktemp -d)/fw-ext-key.pem"   # never in the repo, never committed
openssl genrsa 2048 > "$KEYFILE"
openssl rsa -in "$KEYFILE" -pubout -outform DER | base64 | tr -d '\n'
rm -rf "$(dirname "$KEYFILE")"
```

The base64 output is the manifest `key` (public key only — the private half is
deleted above and never needed again: unpacked loading derives the ID from the
public key alone, and a Chrome Web Store release gets a store-assigned identity
regardless of this key, so discarding it forecloses nothing the roadmap needs;
note this explicitly in Task 12's doc). Record the derived ID via the script
written below.

- [ ] **Step 2: Write `scripts/extension-id.mjs`**

```js
#!/usr/bin/env node
// Prints the extension ID Chromium derives from public/manifest.json's "key":
// sha256 over the DER public key, first 16 bytes, each nibble mapped 0-15 ->
// a-p ("mpdecimal"). Used by docs and by backend/tests/test_fly_config.py's
// cross-pin (which reimplements the same 6 lines in Python).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(new URL('../public/manifest.json', import.meta.url))
const { key } = JSON.parse(readFileSync(manifestPath, 'utf8'))
const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest()
const id = [...digest.subarray(0, 16)]
  .flatMap((b) => [b >> 4, b & 0xf])
  .map((n) => String.fromCharCode(97 + n))
  .join('')
console.log(id)
```

- [ ] **Step 3: Write `public/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Fabulous Writing",
  "version": "0.1.0",
  "description": "Check your writing in any text field with your Fabulous Writing server.",
  "key": "<the base64 public key from Step 1>",
  "minimum_chrome_version": "116",
  "permissions": ["sidePanel", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "sw.js", "type": "module" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["scout.js"], "run_at": "document_idle" }
  ],
  "side_panel": { "default_path": "panel.html" },
  "options_page": "options.html",
  "action": {
    "default_title": "Fabulous Writing",
    "default_icon": { "16": "icons/16.png", "32": "icons/32.png" }
  },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

Notes: `action` exists for the findings badge (Task 5) — without an icon the
badge would render on the generic puzzle piece. `scout.js` is the IIFE bundle —
no loader shim, no `web_accessible_resources` (ruling 1).
`host_permissions: <all_urls>` is the spec's explicit unpacked-phase call.

Generate the icons into `public/icons/` with a dependency-free node script
`scripts/make-icons.mjs` (committed, rerunnable): solid rounded violet squares
in the four sizes, written as valid PNGs via `node:zlib` deflate + hand-built
PNG chunks (IHDR/IDAT/IEND with CRC32 — ~40 lines; any deterministic flat
color is fine, this is a placeholder identity, not brand work). Commit the
generated PNGs.

- [ ] **Step 4: Write the package files**

`package.json` (pin the same major versions as `frontend/package.json`):

```json
{
  "name": "fabulous-writing-browser-extension",
  "private": true,
  "version": "0.1.0",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit && vite build && vite build --config vite.content.config.ts",
    "lint": "oxlint",
    "test": "vitest run",
    "e2e": "node e2e/run.mjs",
    "ext-id": "node scripts/extension-id.mjs"
  },
  "dependencies": {
    "webextension-polyfill": "^0.12.0"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.280",
    "@types/node": "^26.2.0",
    "@types/webextension-polyfill": "^0.12.1",
    "happy-dom": "^20.11.2",
    "oxlint": "^1.79.0",
    "playwright-core": "^1.62.1",
    "typescript": "~7.0.2",
    "vite": "^8.2.1",
    "vitest": "^4.1.9"
  }
}
```

(Adjust minor pins to what `npm install` resolves; commit `package-lock.json`.)

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vite/client"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src", "vite.config.ts", "vite.content.config.ts", "scripts"]
}
```

(The frontend sources arrive through `src/` imports and are type-checked
transitively; they are dependency-free plain TS — `embed/protocol.ts`,
`simulator/textareaAdapter.ts`, `simulator/clickHitTest.ts`,
`findings/severity.ts`, `types.ts`. `types.ts`'s `import type { Scorecard }` is
erased and pulls nothing in at runtime.)

`vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// ESM contexts: service worker (MV3 "type": "module"), panel and options
// pages. Stable, hash-free names — the manifest references them literally.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sw: resolve(import.meta.dirname, 'src/sw.ts'),
        panel: resolve(import.meta.dirname, 'panel.html'),
        options: resolve(import.meta.dirname, 'options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: { environment: 'happy-dom', setupFiles: ['./vitest.setup.ts'] },
})
```

`vitest.setup.ts` + `src/testing/browserMock.ts`: `webextension-polyfill`
**throws at import time** unless `globalThis.chrome.runtime.id` exists, so any
suite transitively importing it dies without a global mock. The setup file
registers `vi.mock('webextension-polyfill', ...)` returning the in-memory mock
(default export): `storage.local` get/set backed by a Map (with an
`onChanged` emitter), `runtime.connect` returning a stub port factory tests can
inspect, `runtime.getManifest` returning `{ version: '0.1.0' }`,
`windows.getCurrent` returning `{ id: 1 }`, plus a `resetBrowserMock()` helper
called in the setup's `beforeEach`. Individual suites refine the stubs per
test.

`vite.content.config.ts`:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The content script: one classic IIFE file, no runtime imports (ruling 1 —
// dynamic import from content scripts is subject to the page's CSP).
// emptyOutDir false: this pass ADDS scout.js to the ESM pass's dist/.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/scout.ts'),
      formats: ['iife'],
      name: 'fwScout',
      fileName: () => 'scout.js',
    },
  },
})
```

`panel.html` / `options.html`: minimal documents loading `src/panel.ts` /
`src/options.ts` as module scripts (Vite rewrites the paths at build):

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Fabulous Writing</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/panel.ts"></script>
  </body>
</html>
```

`.gitignore`: `node_modules/`, `dist/`, `e2e/.tmp/`. `README.md`: two lines
pointing at `docs/browser-extension.md`.

- [ ] **Step 5: Install, build, load**

```bash
cd clients/browser-extension && npm install \
  && node scripts/make-icons.mjs && npm run build && npm run ext-id
```

Expected: `dist/` contains `manifest.json` (copied from `public/`), `sw.js`,
`scout.js`, `panel.html`, `options.html` + assets; `ext-id` prints a 32-char
a-p string. Manually verify once: `chrome://extensions` → Developer mode →
Load unpacked → `dist/` loads with the printed ID and no manifest errors.
(If no Chromium is at hand in this environment, note it in the task report —
the e2e task loads it programmatically and would catch a manifest error.)

- [ ] **Step 6: Write `.github/workflows/extension.yml`**

Mirror `.github/workflows/frontend.yml`'s shape (checkout, setup-node 26 with
npm cache on `clients/browser-extension/package-lock.json`, `npm ci`,
`npm run lint`, `npm test`, `npm run build`) with:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "clients/browser-extension/**"
      - "frontend/src/embed/**"
      - "frontend/src/simulator/**"
      - "frontend/src/findings/severity.ts"
      - "frontend/src/types.ts"
      - ".github/workflows/extension.yml"
  pull_request:
    paths: [same list]
```

(The frontend paths are the shared sources — a change there must rebuild the
extension too.) No coverage/badge machinery — lint+test+build only.

- [ ] **Step 7: Commit**

```bash
git add clients/browser-extension .github/workflows/extension.yml
git commit -m "feat(extension): MV3 scaffold with pinned key, dual-pass build, CI (B43 C2)"
```

---

### Task 4: Internal messaging contract + settings module

**Files:**
- Create: `clients/browser-extension/src/messages.ts`
- Create: `clients/browser-extension/src/settings.ts`
- Test: `src/messages.test.ts`, `src/settings.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `HostMessage`, `EmbedMessage`, `parseHostMessage`,
  `parseEmbedMessage` from `../../../frontend/src/embed/protocol` (path from
  `src/`).
- Produces (used by Tasks 5-9):

```ts
// messages.ts — everything that travels over browser.runtime ports.
// Protocol envelopes pass through the service worker UNTRANSLATED (spec:
// "protocol passes through untranslated"); ctl messages are extension-
// internal lifecycle. Ports are extension-internal (no foreign senders can
// connect without externally_connectable), but parse anyway: a malformed
// message must drop, not crash a context.
export type PortMessage =
  | { relay: Envelope<HostMessage> | Envelope<EmbedMessage> }
  | { ctl: CtlMessage }

export type CtlMessage =
  | { kind: 'openPanel' }                      // scout -> sw (affordance click)
  | { kind: 'panelHello'; windowId: number }   // panel -> sw (port handshake)
  | { kind: 'embedReady'; ready: boolean }     // panel -> sw
  // sw -> scout, field replaced from ANOTHER tab. Carries the fieldId being
  // detached: a scout ignores a detach that does not name its CURRENT
  // session (a same-tab reconnect mints a new fieldId — a detach for the old
  // one arriving late must not kill the new session).
  | { kind: 'detach'; fieldId: string }
  | { kind: 'status'; phase: StatusMessage['payload']['phase']; findingCount: number } // sw -> scout (affordance chip)

export function parsePortMessage(data: unknown): PortMessage | null
export const HOST_KIND = 'browser-extension'
```

Typing note: the protocol parsers return `HostMessage | null` /
`EmbedMessage | null` — the incoming data IS the envelope object (the parsers
validate `fw` on it), so the `relay` case narrows with an explicit
`as Envelope<HostMessage>` / `as Envelope<EmbedMessage>` after the parser
accepts, mirroring how `protocol.ts` itself returns `data as HostMessage`.
Direction is NOT re-derived from the payload downstream: the service worker
discriminates by **port name** — messages on a `'field'` port are host-role,
messages on a `'panel'` port are embed-role — and drops a `relay` whose inner
message fails the parser for that port's direction.

```ts
// settings.ts
export const DEFAULT_SERVER_URL = 'https://fabulous-writing.fly.dev'
/** Origin only (scheme http/https + host [+ port]); trailing slash stripped.
 *  Returns null for anything else — the caller shows a validation error. */
export function normalizeServerUrl(input: string): string | null
export async function getServerUrl(): Promise<string>
export async function setServerUrl(url: string): Promise<void>
export function onServerUrlChanged(cb: (url: string) => void): void
```

- [ ] **Step 1: Write the failing tests**

`messages.test.ts` — `parsePortMessage` accepts `{relay}` wrapping a valid host
envelope (build one with `envelope()`/hand-rolled `fw:1` hello) and a valid
embed envelope; accepts each `ctl` variant; returns null for: non-objects, a
`relay` whose inner message fails BOTH protocol parsers, a `ctl` with an
unknown `kind`, `panelHello` without a numeric `windowId`, `status` with a
non-numeric `findingCount`. `settings.test.ts` — `normalizeServerUrl`:
`'https://fw.example'` → itself; `'https://fw.example/'` → stripped;
`'http://localhost:8100'` → itself; null for `'ftp://x'`, `'https://fw.example/app'`
(path), `'fw.example'` (no scheme), `''`. `getServerUrl` returns the default
when storage is empty and the stored value otherwise (the global
`browserMock` from Task 3's `vitest.setup.ts` provides `storage.local`).
Also: `ctl detach` without a string `fieldId` → null; `ctl status` with an
unknown phase → null.

- [ ] **Step 2: Run to verify failure** — `npm test` in the extension dir.

- [ ] **Step 3: Implement**

`parsePortMessage`: shape-check the wrapper, then delegate the `relay` case to
`parseHostMessage(data.relay) ?? parseEmbedMessage(data.relay)` (non-null
result wins; both null → drop). `ctl` case: a `switch` on `kind` with per-field
typechecks mirroring protocol.ts's style. `normalizeServerUrl`: `new URL(input)`
in try/catch; require `protocol` http:/https:, `pathname` `'/'`, empty
`search`/`hash`/`username`/`password`; return `url.origin`.
`settings.ts` uses `browser.storage.local` under key `serverUrl` and
`browser.storage.onChanged` for the subscription.

- [ ] **Step 4: Run tests** — `npm test`, `npm run lint`, `npm run build`: green.

- [ ] **Step 5: Commit**

```bash
git add clients/browser-extension/src
git commit -m "feat(extension): port message contract + server-url settings (B43 C2)"
```

---

### Task 5: Connection registry + service worker

**Files:**
- Create: `clients/browser-extension/src/registry.ts` (pure), `src/panelHost.ts`,
  and the real `src/sw.ts`
- Test: `src/registry.test.ts`

**Interfaces:**
- Consumes: `PortMessage`, `parsePortMessage`, protocol types.
- Produces (Tasks 6-8 rely on the routing behavior, not on imports):

```ts
// registry.ts — pure state machine, one instance in the service worker.
// State per window: the connected field (tab, fieldId, capabilities, meta,
// latest full text) and whether that window's panel has reported embedReady.
// Every operation returns effects; sw.ts executes them. This is what makes
// the routing unit-testable without chrome.* mocks.
export interface SendEffect {
  kind: 'send'
  to: 'panel' | 'field' | 'oldField'   // oldField: the REPLACED field's tab port
  windowId: number
  tabId?: number                        // required for to:'field'/'oldField'
  message: PortMessage
}
export interface BadgeEffect { kind: 'badge'; tabId: number; text: string }
export type Effect = SendEffect | BadgeEffect

export class Registry {
  fieldConnected(windowId: number, tabId: number, msg: Envelope<FieldConnectedMessage>): Effect[]
  textChanged(windowId: number, tabId: number, msg: Envelope<TextChangedMessage>): Effect[]
  hostRelay(windowId: number, tabId: number, msg: Envelope<HostMessage>): Effect[]   // replaceResult, markingClicked, fieldDisconnected
  embedRelay(windowId: number, msg: Envelope<EmbedMessage>): Effect[]                // findings, applyReplacement, selectFinding, status
  panelReady(windowId: number, ready: boolean): Effect[]
  fieldPortGone(windowId: number, tabId: number): Effect[]
  panelPortGone(windowId: number): void
}
```

Routing rules (the tests pin exactly these):
1. `fieldConnected` from tab T, window W: if W already has a field connected in
   a **different tab**, emit
   `{kind:'send', to:'oldField', windowId, tabId: oldTabId,
   message:{ctl:{kind:'detach', fieldId: oldFieldId}}}` first (that tab's
   scout disposes its session). A same-tab replacement emits **no detach** —
   the scout already disposed its own previous session locally before
   connecting the new one (Task 7), and a detach sent back to tab T would name
   the old fieldId only; still, not emitting it at all keeps the race surface
   zero. Store the new field's tabId, fieldId, capabilities, meta, text. If
   W's panel is ready, also emit `{relay: msg}` to the panel — otherwise
   nothing more (synthesized later, rule 4).
2. `textChanged`: update stored text; relay to panel only if ready. Messages
   from a tab that is NOT the connected tab of its window are dropped (a stale
   scout racing its own detach).
3. `hostRelay` (`replaceResult`/`markingClicked`): relay if the sender is the
   connected tab and the panel is ready; else drop. `fieldDisconnected` from
   the connected tab clears the entry, relays to the panel (if ready), and
   clears the badge (`{kind:'badge', tabId, text:''}`).
4. `panelReady(true)`: **no-op if W was already marked ready** (`bridge.ts`
   answers every `hello` with a `ready`, and the relay's own edge guard — Task
   8 — is belt; this is suspenders: a duplicate must not re-synthesize).
   Otherwise mark ready and, if W has a connected field, synthesize a fresh
   `fieldConnected` envelope from stored state (fieldId, capabilities, meta,
   **latest** text) and emit to the panel. This covers both orderings — field
   connected before the panel/embed finished booting, and a panel closed and
   reopened onto a live field. `panelReady(false)`: mark not ready, keep field
   state.
5. `embedRelay`: `status` is **not** relayed to the session (it has no use for
   it) — it yields `{kind:'badge', tabId, text: findingCount > 0 ?
   String(findingCount) : ''}` plus
   `{kind:'send', to:'field', …, message:{ctl:{kind:'status', phase,
   findingCount}}}` (this is what drives the affordance chip — Task 7 consumes
   it). All other embed messages route to the connected tab's field port
   verbatim. With no field connected, messages drop — except `status`, whose
   badge effect still targets the **last** connected tabId (kept for exactly
   this) so a stale count is cleared after a disconnect.
6. `fieldPortGone` (navigation, tab close): if it was the connected tab, clear
   the entry, emit a synthesized `fieldDisconnected` to the panel (if ready),
   and clear the badge (`text: ''`).

- [ ] **Step 1: Write failing tests** — one test per numbered rule above, plus:
  cross-tab replace-while-panel-not-ready (detach emitted to the old tab with
  the OLD fieldId, nothing to panel, later `panelReady(true)` synthesizes the
  NEW field); **same tab, new fieldId → no detach effect** (the Critical-1
  regression pin); **duplicate `panelReady(true)` → no second synthesis**;
  `status` → both the ctl-status send AND the badge effect, and NO raw relay
  of the status envelope; badge-cleared-on-zero (`findingCount: 0` →
  `text: ''`); badge-cleared-after-disconnect (`status` arriving with no
  connected field targets the last connected tabId). Build envelopes with
  plain object literals (`{fw: 1, type: 'fieldConnected', payload: {...}}`).

- [ ] **Step 2: Run to verify failure** — `npm test`.

- [ ] **Step 3: Implement `registry.ts`** per the rules; internal state is a
  `Map<number, WindowState>`.

- [ ] **Step 4: Implement `panelHost.ts` + `sw.ts`**

```ts
// panelHost.ts — THE Chromium-only module (spec: "All chrome.sidePanel calls
// live in a thin panel-host abstraction"). Firefox (C4) swaps this file for a
// sidebar_action variant; nothing else in the extension may touch chrome.*.
export function initPanelBehavior(): void {
  // Fallback opener: clicking the toolbar icon opens the panel WITHOUT any
  // gesture-propagation question. Called once at SW top level.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}
export function openPanel(windowId: number, onError: (e: unknown) => void): void {
  // MUST be called synchronously inside the port.onMessage handler for the
  // affordance click — sidePanel.open requires a user gesture, and any await
  // before it drops the gesture context. Whether activation propagates from a
  // content-script click over a long-lived port is a Chromium behavior we
  // VERIFY manually in Task 7 step 5; if it ever regresses, onError surfaces
  // it (the sw sends ctl status phase 'error' to the chip) and the toolbar-
  // icon fallback above still works.
  chrome.sidePanel.open({ windowId }).catch(onError)
}
export function setBadge(tabId: number, text: string): void {
  // .catch: the post-disconnect badge clear targets the LAST connected tab
  // (registry rule 5), which may already be closed — a rejected promise for
  // a gone tab is expected, not an error.
  chrome.action.setBadgeText({ tabId, text }).catch(() => {})
}
```

`sw.ts`: `browser.runtime.onConnect` — ports named `'field'` (sender tab gives
`tabId`/`windowId`) and `'panel'` (windowId arrives via `panelHello`). Each
incoming message goes through `parsePortMessage`; nulls drop. Dispatch to the
`Registry` instance by message type, execute returned effects (`postMessage` on
the right port; `setBadge` for badge effects; a `try/catch` around each post —
a disconnected port must not kill the handler). At SW top level, call
`initPanelBehavior()` once. `ctl openPanel` calls `openPanel(windowId,
onError)` synchronously (see above); `onError` sends
`{ctl:{kind:'status', phase:'error', findingCount:0}}` back to that field port
so the chip shows the failure instead of nothing happening. Port bookkeeping:
`Map<windowId, Port>` for panels, `Map<tabId, Port>` for fields, cleaned in
`onDisconnect` (which also calls `fieldPortGone`/`panelPortGone`).
MV3 lifetime note (write it as a code comment): the registry is in-memory,
ACCEPTED for v1 because Chrome ≥116 (the manifest's own
`minimum_chrome_version`) keeps the SW alive while any runtime port is
connected — so state loss happens only on update/crash, and the recovery
path is the scout's reconnect-on-next-interaction (Task 7). A
`chrome.storage.session`-backed registry is a later hardening. Second
accepted v1 limit, same comment block: the registry keys on the windowId
captured at port-connect time — dragging a connected tab into another window
routes to the old window's panel until reconnect.

- [ ] **Step 5: Gates** — `npm test`, `npm run lint`, `npm run build`: green.

- [ ] **Step 6: Mutation-verify** — in `registry.ts`, drop the
  `panelReady(true)` synthesis (rule 4) — its test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add clients/browser-extension/src
git commit -m "feat(extension): per-window connection registry + service-worker routing (B43 C2)"
```

---

### Task 6: Host-page adapter integration + field session

Two halves, one deliverable: (A) make the lifted `TextareaAdapter` correct on
arbitrary host pages — today two load-bearing pieces live only in
`simulator.css`, so on a real site the overlay positions at the wrong origin
and paints invisibly (or over the text); (B) the content-side session that
plays the protocol's host role for one field.

**Files:**
- Modify: `frontend/src/simulator/textareaAdapter.ts` (the ONE shared-source
  change this plan makes — the file's own header calls itself the C2
  blueprint; the simulator's rendering must stay pixel-identical)
- Modify: `frontend/src/simulator/textareaAdapter.test.ts` (extend)
- Create: `clients/browser-extension/src/session.ts`
- Test: `clients/browser-extension/src/session.test.ts`

**Interfaces:**
- Consumes: `createTextareaAdapter` from
  `../../../frontend/src/simulator/textareaAdapter` (imported, NOT copied),
  `findingIdAt` from `../../../frontend/src/simulator/clickHitTest`,
  protocol types + `PROTOCOL_VERSION`.
- Produces (Task 7's scout consumes exactly this):

```ts
export interface Session {
  fieldId: string
  handleEmbedMessage(msg: Envelope<EmbedMessage>): void
  /** Detach without notifying (SW/scout-initiated replace). */
  detach(): void
  /** User-initiated disconnect: sends fieldDisconnected, then detaches. */
  stop(): void
}
export function startSession(
  el: HTMLTextAreaElement,
  send: (msg: Envelope<HostMessage>) => void,
): Session
```

**Part A — adapter host-page integration** (in `textareaAdapter.ts` itself;
each change is idempotent under the simulator's CSS, which already imposes the
same values via `.sim-field-wrap`/`#field` rules):

1. **Overlay position.** The overlay is `position:absolute; top:0; left:0` and
   lands at the origin of its CONTAINING BLOCK — the nearest positioned
   ancestor, or, with none, the initial containing block. The simulator
   supplies a `position:relative` wrapper; arbitrary pages don't, and
   `el.offsetTop/offsetLeft` would NOT fix it (they measure against
   `offsetParent`, which CSSOM defines as `body` for unpositioned trees —
   the absolute overlay meanwhile resolves against the ICB, so body's
   default 8px margin alone displaces every mark). Instead, self-correct by
   measured delta in `syncOverlayGeometry` (which re-runs on resize): after
   copying the size properties, read both rects and shift the overlay by the
   difference —
   `const d = el.getBoundingClientRect(); const o = overlay.getBoundingClientRect();`
   `overlay.style.top = `${(parseFloat(overlay.style.top) || 0) + d.top - o.top}px``
   (same for `left`). This is exact under ANY containing block, margin, or
   wrapper, converges in one step, and needs no scroll re-sync: the overlay
   is a sibling of the field, so it lives in the same scrolling context and
   moves with it. In the simulator the delta is 0 — no visual change. Test
   with a happy-dom `getBoundingClientRect` stub returning offset rects.
2. **Paint order + visibility.** Save the field's inline `position`,
   `z-index`, and `background-color` values at adapter creation. Then: if
   `getComputedStyle(el).position === 'static'`, set
   `el.style.position = 'relative'`; set `el.style.zIndex = '1'`; copy the
   COMPUTED `backgroundColor` onto `overlay.style.backgroundColor` (the
   overlay now paints the field's own background so highlights sit on the
   expected ground) and set `el.style.backgroundColor = 'transparent'`.
   `dispose()` restores the three saved inline values verbatim (empty string
   when they were unset). Without this, GitHub's opaque composer hides every
   mark; with a static-positioned field the overlay would instead paint OVER
   the real text.
3. Document both in the module comment: this is the host-page contract the
   simulator page happens to also satisfy via CSS.

**Part B — session behavior** — this is `frontend/src/simulator/main.ts`'s
connected-state logic, ported off its DOM harness (read that file first; every
guard it grew in C1 review rounds carries over):

1. On start: `fieldId = 'fw-' + (crypto.randomUUID?.() ??
   `${Date.now()}-${Math.random().toString(36).slice(2)}`)` —
   `crypto.randomUUID` is secure-context-gated and content scripts share the
   page's context, so on plain-`http` sites it is `undefined`; create the
   adapter; register a `MutationObserver` on `document.documentElement`
   (childList+subtree) that calls `stop()` when `!el.isConnected` (the
   auto-disconnect for Turbo navigations that replace the composer); send
   `fieldConnected` with `text: adapter.extract()`, the adapter's
   `capabilities()`, `meta: { url: location.href, fieldKind: 'textarea' }`.
2. `adapter.onChange` → `textChanged` with full text.
3. Field `click` listener → `findingIdAt(currentFindings, selectedId, caret)` →
   `markingClicked` (tracking `selectedId` from incoming `selectFinding`
   messages exactly as the simulator does).
4. `handleEmbedMessage`: `findings` (matching fieldId) → `setMarkings` + keep
   for hit-testing; `selectFinding` → track + `flashFinding` when non-null;
   `applyReplacement` → the simulator's full guard chain verbatim: refuse with
   current text when detached; refuse foreign fieldId with empty text; wrap
   `adapter.applyReplacement` in try/catch → `replaceResult` echo
   `{fieldId, ok, text}` with the request's envelope `requestId`.
5. `detach()`: disconnect observer, remove listeners, `adapter.dispose()`,
   idempotent (a second call is a no-op). `stop()`: send `fieldDisconnected`,
   then `detach()`.

- [ ] **Step 1: Write the failing adapter tests** (in
  `textareaAdapter.test.ts`, happy-dom): stub `getBoundingClientRect` on the
  textarea and the overlay via `Object.defineProperty` (happy-dom computes no
  layout) so the field reads at `{top: 108, left: 8}` and the fresh overlay at
  `{top: 100, left: 0}` → after creation `overlay.style.top === '8px'` and
  `left === '8px'` (the measured delta); a second `syncOverlayGeometry` run
  with rects now equal leaves them unchanged (convergence); a field with an inline
  background keeps painting it — on the OVERLAY — while the field itself
  becomes transparent; a statically-positioned field gets
  `position:relative`/`z-index:1`; `dispose()` restores the original inline
  `position`/`z-index`/`background-color` (both the previously-set and the
  previously-unset case).

- [ ] **Step 2: Run to verify failure** — from `frontend/`:
  `npm test -- src/simulator`.

- [ ] **Step 3: Implement Part A; run ALL frontend gates** — `npm test`,
  `rtk proxy npm run lint`, `npm run build`, `npm run check:embed`. The
  existing simulator suites must stay green untouched except where they assert
  the overlay's initial style set.

- [ ] **Step 4: Write the failing session tests** — port the simulator's test
  patterns (`frontend/src/simulator/main.test.ts` is the reference):
  fieldConnected sent on start with extracted text + capabilities; fieldId has
  the `fw-` prefix and the fallback branch produces one when
  `crypto.randomUUID` is absent (delete it from the mock realm for that test);
  textChanged on input; findings → adapter marks in the overlay DOM;
  applyReplacement happy path mutates the textarea and echoes ok:true with the
  new text and the same requestId; expectedText mismatch echoes ok:false
  without mutation; foreign fieldId echoes ok:false with empty text; adapter
  throw echoes ok:false; stop() sends fieldDisconnected and disposes (overlay
  removed); a second detach() is a no-op; element removal from the DOM
  triggers stop() (MutationObserver fires in happy-dom).

- [ ] **Step 5: Implement Part B; run the extension gates** — from
  `clients/browser-extension/`: `npm test`, `npm run lint`, `npm run build`.

- [ ] **Step 6: Mutation-verify** — (a) remove the `expectedText` refusal
  delegation (pass `el.value.slice(from, to)` instead of the request's
  `expectedText` into the adapter) — the mismatch test must fail; (b) remove
  the `dispose()` restore of the saved inline values — the restore test must
  fail. Restore both by re-editing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/simulator clients/browser-extension/src
git commit -m "feat(extension): host-page adapter integration + field session (B43 C2)"
```

---

### Task 7: Scout — eligibility, affordance, wiring

**Files:**
- Create: `clients/browser-extension/src/detect.ts`, `src/affordance.ts`,
  `src/marks.css.ts`, and the real `src/scout.ts`
- Test: `src/detect.test.ts`, `src/affordance.test.ts`, `src/scout.test.ts`

**Interfaces:**
- Consumes: `PortMessage`/`CtlMessage` (Task 4), `startSession`/`Session`
  (Task 6).
- Produces:

```ts
// detect.ts
export const MIN_FIELD_WIDTH = 120
export const MIN_FIELD_HEIGHT = 40
/** Visible, enabled, writable <textarea> at least MIN_* in rendered size. */
export function isEligibleField(el: EventTarget | null): el is HTMLTextAreaElement

// affordance.ts — the shadow-DOM connect chip.
export interface Affordance {
  showFor(el: HTMLTextAreaElement): void   // position near top-right of el
  hide(): void
  setState(state: 'idle' | 'connected' | 'signed-out' | 'busy' | 'error'): void
  setCount(findingCount: number): void
  dispose(): void
}
export function createAffordance(onClick: (el: HTMLTextAreaElement) => void): Affordance
```

- [ ] **Step 1: Write failing tests**

`detect.test.ts`: eligible plain textarea (happy-dom: stub
`getBoundingClientRect` to 200×80) → true; `<input type="text">` → false (v1 is
textarea-only — the spec's `<input>` mention is "designed for", the adapter
handles textarea; keep input out of detection until an input-capable adapter
exists); `disabled` → false; `readOnly` → false; 200×20 → false; `display:none`
(rect 0×0) → false; non-element target → false.

`affordance.test.ts`: `showFor` attaches ONE shadow host to
`document.documentElement` (not `body` — GitHub replaces body subtrees on Turbo
visits) and positions it; click invokes the callback with the element;
`setState('connected')` / `setCount(3)` are reflected in the chip's
text/dataset; `hide()` removes it from view without destroying the host;
`dispose()` removes the host. (These tests reach inside the shadow root — see
Step 3's `mode: 'open'` choice; a closed root would make them impossible.)

`scout.test.ts` (drive scout's wiring with the global browser mock's stub
port; extract scout's message handler into a testable function if attaching
real document listeners proves awkward — the three behaviors below MUST be
pinned): a `ctl detach` naming a foreign fieldId is ignored while one naming
the current session's detaches it; after the port's `onDisconnect` fires, the
chip is `idle`, the affordance host is still in the DOM, and the next
affordance interaction opens a NEW port; `ctl status` updates the chip's
state and count (incl. `signed-out` and `error` mapping).

- [ ] **Step 2: Run to verify failure** — `npm test`.

- [ ] **Step 3: Implement**

`detect.ts` — straight predicate:

```ts
export function isEligibleField(el: EventTarget | null): el is HTMLTextAreaElement {
  if (!(el instanceof HTMLTextAreaElement)) return false
  if (el.disabled || el.readOnly) return false
  const rect = el.getBoundingClientRect()
  return rect.width >= MIN_FIELD_WIDTH && rect.height >= MIN_FIELD_HEIGHT
}
```

`affordance.ts` — one shadow host (`position: absolute`, `z-index` high,
top/left from `getBoundingClientRect()` + `scrollX/scrollY`, chip anchored to
the field's top-right corner), **`mode: 'open'`** shadow root (host pages
still cannot restyle it — every style lives inside the root; open mode is
what makes the tests above possible). Chip: a `<button>` with the state as
`data-state`, the finding count as its text when connected and > 0, `✓` when
connected and clean, `✳` idle, `⚠` signed-out, `!` error. Hover/focus
lifecycle is DRIVEN BY scout.ts (below) — the affordance only renders.

`marks.css.ts` — the overlay mark colors as an exported template string
(mirroring the `.fw-mark-*` rules in `frontend/src/simulator/simulator.css`,
`!important`-free, plus `.fw-mark-flash`); scout injects it once as a
`<style data-fw-marks>` element on first connect (the adapter's load-bearing
styles are inline after Task 6 — this is cosmetic color only).

`scout.ts` — the content-script entry (kept small; logic lives in the modules):

- Delegation: document-level `focusin`/`focusout` + `mouseover`/`mouseout`
  (all four BUBBLE — `mouseenter`/`mouseleave` do not and cannot be delegated)
  show/hide the affordance for eligible fields; hide on a short delay,
  cancelled when `relatedTarget` (or the new focus target) is the chip's host.
  No scanning, no detection observer (ruling 2) — a Turbo-injected field is
  detected the moment it's interacted with. One-shot at startup: if
  `document.activeElement` is already an eligible field (autofocused
  composer), show the affordance for it immediately.
- The runtime port is **lazy**: `browser.runtime.connect({name:'field'})` on
  the first affordance show, not at `document_idle` — a port per idle tab
  would also pin the SW non-idle for nothing. On port `onDisconnect`
  (SW restart, extension update): stop the session (if any), reset the chip
  to `idle`, null the port — the NEXT interaction reconnects. The affordance
  itself is NOT disposed; losing it until page reload would strand the tab.
- On affordance click (idle state): if a previous session exists in this tab,
  `session.detach()` it locally first (same-tab replace — the SW emits no
  detach for this case, by design, registry rule 1); then
  `port.postMessage({ctl:{kind:'openPanel'}})`, inject the marks style, start
  the session (Task 6) for that element, chip `setState('busy')`.
- Click on the chip of the *connected* field: disconnect — `session.stop()`
  (sends `fieldDisconnected`), chip back to `idle` locally (the embed's
  status stream is not tied to connectivity; nothing else resets it).
- Incoming port messages via `parsePortMessage`: `ctl detach` → ignore unless
  `fieldId` matches the current session's, else `session.detach()` silently
  (no `fieldDisconnected` back — the SW already replaced the entry) + chip
  `idle`; `ctl status` → `setState`/`setCount` (`signed-out` phase →
  `'signed-out'`, `error` → `'error'`); `relay` (embed messages) → forward
  to the session.
- `pagehide`: `session.stop()` + affordance `dispose()`.

- [ ] **Step 4: Gates** — `npm test`, `npm run lint`, `npm run build`: green.

- [ ] **Step 5: Manual gesture check** (the one MV3 behavior no test covers —
  `sidePanel.open` from a port message): build, load `dist/` unpacked, open
  any http(s) page with a textarea, click the chip. Expected: the side panel
  opens. If Chromium refuses with a user-gesture error, record it in the task
  report and verify the toolbar-icon fallback (`initPanelBehavior`) opens the
  panel — the affordance then surfaces `error` via the SW's onError path. Do
  not silently skip this step; if no Chromium is available in the execution
  environment, escalate to the controller instead of marking it done.

- [ ] **Step 6: Commit**

```bash
git add clients/browser-extension/src
git commit -m "feat(extension): scout content script — delegated detection + shadow-DOM affordance (B43 C2)"
```

---

### Task 8: Panel page — iframe, hello loop, relay

**Files:**
- Create: real `clients/browser-extension/src/panel.ts`, `src/relay.ts`;
  extend `panel.html` (iframe container + header)
- Test: `src/relay.test.ts`

**Interfaces:**
- Consumes: `getServerUrl`/`onServerUrlChanged` (Task 4), `PortMessage`,
  `parseEmbedMessage`, `PROTOCOL_VERSION`, `HOST_KIND`.
- Produces:

```ts
// relay.ts — the testable core; panel.ts is thin DOM/port wiring around it.
export interface RelayCallbacks {
  toEmbed(msg: object): void          // iframe.contentWindow.postMessage(msg, serverOrigin)
  toPort(msg: PortMessage): void      // port.postMessage
  onReadyChange(ready: boolean): void // -> ctl embedReady
}
export function createRelay(cb: RelayCallbacks, hostVersion: string): {
  // hostVersion: panel.ts passes browser.runtime.getManifest().version —
  // relay.ts itself stays polyfill-free.
  /** window 'message' events land here; the caller has ALREADY verified
   *  event.origin === serverOrigin && event.source === iframe.contentWindow. */
  fromEmbed(data: unknown): void
  fromPort(data: unknown): void       // SW-relayed host messages -> toEmbed
  start(): void                       // arm the hello loop
  dispose(): void
}
export const HELLO_RETRY_MS = 250
export const MAX_HELLO_ATTEMPTS = 30
```

Behavior (the hello loop is `simulator/main.ts`'s, same constants and cap —
read its Finding-28 comment): `start()` sends
`{fw: PROTOCOL_VERSION, type: 'hello', payload: {host: {kind: HOST_KIND,
version: hostVersion}}}` (the `createRelay` parameter) every `HELLO_RETRY_MS` until `ready` arrives or the attempt cap
trips (then `onReadyChange` never fires — panel.ts shows "embed not
responding"). `fromEmbed`: `parseEmbedMessage`; `ready` → stop loop and fire
`onReadyChange(true)` **only on a false→true transition** — `bridge.ts`
answers EVERY hello with a `ready`, so 1-2 duplicates are normal, and each
un-guarded `embedReady` would make the registry re-synthesize `fieldConnected`
(cancelling and restarting checks, burning LLM credits; the registry's rule-4
no-op is the second layer of this same defense). The ready flag resets to
false on `dispose()` and on `start()` (the iframe-load re-arm). `ready` is
panel-internal and never forwards; every OTHER parsed embed message forwards
as `{relay: msg}` via `toPort`.
`fromPort`: `parsePortMessage`; `relay` entries that parse as HOST messages go
`toEmbed` verbatim; `ctl` is ignored here (none flow SW→panel today).
`dispose()` clears the timer.

`panel.ts`: read server URL → `serverOrigin`; render header (`Fabulous
Writing`, an options link via `browser.runtime.openOptionsPage()` button) +
`<iframe src="${serverOrigin}/embed" id="embed">` (**no `sandbox` attribute**
— the spec's social-login note requires an unsandboxed iframe); connect the
`'panel'` port; `browser.windows.getCurrent()` (polyfill, works in both the
side panel and a plain tab — the e2e path; no extra permission needed) →
`{ctl:{kind:'panelHello', windowId}}`; wire `window.addEventListener('message',
…)` with the origin+source pin, the relay, and the iframe `load` event
re-arming `start()` (a reloaded embed forgets everything — same reasoning as
the simulator's load listener). `onReadyChange` → `{ctl:{kind:'embedReady',
ready}}`. `onServerUrlChanged` → `location.reload()` (simplest correct
response; the SW re-synthesizes `fieldConnected` on the next `embedReady`).

- [ ] **Step 1: Write failing tests** (`relay.test.ts`): hello sent on start
  with kind `browser-extension` and retried until `ready`; cap stops the loop;
  `ready` fires `onReadyChange(true)` and is NOT forwarded to the port; a
  SECOND `ready` fires nothing further; after `start()` is called again (the
  iframe-load re-arm) the next `ready` fires `onReadyChange(true)` once more;
  `findings`/`status`/`applyReplacement`/`selectFinding` forward as `{relay}`;
  garbage from the embed drops; port `{relay: <host textChanged envelope>}`
  reaches `toEmbed` verbatim (same object); port garbage drops; `dispose`
  stops the timer (vi.useFakeTimers throughout).

- [ ] **Step 2: Run to verify failure** — `npm test`.

- [ ] **Step 3: Implement** `relay.ts` then `panel.ts` per the behavior above.

- [ ] **Step 4: Gates** — `npm test`, `npm run lint`, `npm run build`: green.

- [ ] **Step 5: Commit**

```bash
git add clients/browser-extension/src clients/browser-extension/panel.html
git commit -m "feat(extension): side-panel host — embed iframe, hello loop, port relay (B43 C2)"
```

---

### Task 9: Options page

**Files:**
- Create: real `clients/browser-extension/src/options.ts`; extend `options.html`
- Test: `src/options.test.ts`

**Interfaces:**
- Consumes: `normalizeServerUrl`, `getServerUrl`, `setServerUrl`,
  `DEFAULT_SERVER_URL` (Task 4).
- Produces: user-visible server-URL configuration; no exports.

- [ ] **Step 1: Write failing tests** — rendering into happy-dom: the input is
  prefilled from `getServerUrl`; Save with `http://localhost:8100` persists via
  `setServerUrl` and shows "Saved"; Save with `fw.example` (no scheme) shows
  the validation message and does NOT persist; "Reset to default" writes
  `DEFAULT_SERVER_URL`.

- [ ] **Step 2: Run to verify failure** — `npm test`.

- [ ] **Step 3: Implement** — a label + `<input type="url">` + Save + Reset,
  a status line (`role="status"`), ~40 lines of plain DOM code; note under the
  field: "Your Fabulous Writing server. The panel reloads on change."

- [ ] **Step 4: Gates** — `npm test`, `npm run lint`, `npm run build`: green.

- [ ] **Step 5: Commit**

```bash
git add clients/browser-extension/src clients/browser-extension/options.html
git commit -m "feat(extension): options page — server URL (B43 C2)"
```

---

### Task 10: Playwright e2e — full loop against a real backend

The spec's exit criterion needs the composed system proven: connect → login →
type → findings → overlay → apply → field text replaced and re-checked.
Local-only (not in CI — it boots a backend); `npm run e2e`.

**Files:**
- Create: `clients/browser-extension/e2e/fixture.html`, `e2e/run.mjs`,
  `e2e/extension.spec.mjs`

**Interfaces:**
- Consumes: built `dist/` (extension) and `frontend/dist` (embed);
  `scripts/extension-id.mjs` for the allowlist entry; backend run via
  `uv --directory ../../backend run uvicorn` on port **8100**.
- Produces: a repeatable local gate; its run instructions land in Task 12's doc.

- [ ] **Step 1: Write `e2e/fixture.html`** — a plain page (`<h1>`, one
  `<textarea id="box" rows="8" cols="60">`) served over http (content scripts
  do not run on `file:`).

- [ ] **Step 2: Write `e2e/run.mjs`** — orchestration:

1. Preflight: require `frontend/dist/embed.html` and `dist/manifest.json`
   (error with the build commands if missing). Ports 8100/8101 must be free
   (error out if not — NEVER kill the occupant).
2. Create `e2e/.tmp/<timestamp>/`; write `config.yaml` for the backend with
   EXACTLY these keys (`Settings.environment` is
   `Literal["dev", "staging", "production"]` — "development" fails
   validation and the backend never boots):
   `environment: dev`; auth in **local mode with `ephemeral_secret: true`**
   (no Supabase dependency); `db_path: <tmp>/fabulous.db` — this one is
   NON-NEGOTIABLE: `Settings.db_path` defaults to `backend/data/fabulous.db`
   (anchored at the backend dir, NOT cwd), so omitting it writes the owner's
   LIVE database; `frontend.dist_dir` → absolute path of `frontend/dist`;
   `embed.allowed_ancestors: ["chrome-extension://<id from extension-id.mjs>"]`.
   Leave `rules_dir`, `dictionaries_dir`, and every other path key at its
   default — they point at the repo's own read-only rule/dictionary content,
   and redirecting them into the tmp dir would remove the very rules the
   deterministic probe below depends on. `run.mjs` asserts before spawning:
   the resolved `db_path` is inside `e2e/.tmp/`, abort otherwise.
3. Spawn the backend:
   `uv --directory <repo>/backend run uvicorn app.main:app --port 8100` with
   env `FW_CONFIG_FILE=<tmp>/config.yaml`,
   `FW_ADMIN_EMAIL=e2e-admin@example.com`, `FW_ADMIN_PASSWORD=<random ≥12
   chars, generated per run, passed via env only>`. Poll
   `http://localhost:8100/api/health` (60s cap).
4. Spawn a `node:http` static server for `e2e/` on 8101.
5. Run the spec (import `./extension.spec.mjs`, plain async function — no
   Playwright test-runner dependency; `playwright-core` only, matching the
   repo's screenshot-script pattern in `frontend/scripts/`), passing
   `{adminEmail, adminPassword}`.
6. Teardown always (SIGTERM children, remove nothing outside `e2e/.tmp`).
   Exit non-zero on failure with the step name.

- [ ] **Step 3: Write `e2e/extension.spec.mjs`** — the flow:

```js
import { chromium } from 'playwright-core'
// launchPersistentContext(tmpProfile, { channel: 'chromium', headless: true,
//   args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] })
```

`channel: 'chromium'` is load-bearing, not stylistic: the default
`chrome-headless-shell` build CANNOT load extensions — only the full
`chromium` build's new headless mode can. If launch fails because the local
`playwright-core` resolution pins a browser revision that isn't cached, run
`npx playwright install chromium` from `clients/browser-extension/` (note this
in the run doc too).

1. **API preflight** (fail fast with a clear message before any browser work):
   login `POST http://localhost:8100/api/auth/login` with the admin creds;
   run the check API on the probe text `"This is is a test."` the way the
   embed would (inspect `backend/app/api/checks.py` for the exact request
   shape) and assert at least one finding — the doubled "is is" trips the
   repetition rule deterministically without any LLM. If the default profile
   setup requires a step first, do it here via the API and record it in the
   run doc.
2. Open `http://localhost:8101/fixture.html`; assert `scout.js` ran (hover the
   textarea → the affordance shadow host appears).
3. Open `chrome-extension://<id>/panel.html` in a second tab (the spec's own
   testing note: the panel as a normal page is equivalent — Playwright cannot
   drive the real side panel). Set the server URL first through
   `chrome-extension://<id>/options.html` (fill `http://localhost:8100`, Save)
   — this also exercises Task 9 for real.
4. In the fixture tab: focus the textarea, click the affordance chip.
5. In the panel tab: wait for the embed iframe; inside its frame, fill the
   login form (admin creds) and submit; wait for the sidebar.
6. Fixture tab: type `This is is a test.` into the textarea.
7. Panel tab: wait for a finding to render in the sidebar (frame locator).
   Fixture tab: assert the mirror overlay contains a `.fw-mark` span AND
   assert its **geometry** (the spec's "overlay geometry via e2e"): the
   mark's `boundingBox()` is fully contained within the textarea's
   `boundingBox()`, its height is a single line (< 1.5 × the computed
   line-height), and its horizontal position is to the right of the text
   start (the doubled word is mid-sentence, so `mark.x > textarea.x + 10`).
   This is the assertion that catches a mispositioned or invisible overlay —
   existence alone proves nothing about paint.
8. Panel: click the finding's suggestion apply button; fixture: assert the
   textarea value changed (the doubled word collapsed) and, after the
   re-check, the overlay mark for it is gone.
9. Badge/status: assert the affordance chip shows the connected state.
10. Disconnect: click the chip again; assert the overlay is removed and the
    panel shows the embed's disconnected strip text.

Screenshots on failure into `e2e/.tmp/` for diagnosis.

- [ ] **Step 4: Run it** — from `clients/browser-extension/`:
  `npm run build && (cd ../../frontend && npm run build) && npm run e2e`
  Expected: PASS. Iterate here — this task is the integration crucible; selector
  and timing fixes are expected. If headless extension loading proves flaky on
  this machine, document `HEADFUL=1` env support in `run.mjs` as the fallback
  and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add clients/browser-extension/e2e
git commit -m "test(extension): playwright e2e — connect/login/findings/apply loop (B43 C2)"
```

---

### Task 11: Fly allowlist + cross-pin guard

**Files:**
- Modify: `deploy/fly/config.yaml` (add the `embed:` block)
- Test: `backend/tests/test_fly_config.py`

**Interfaces:**
- Consumes: the pinned manifest key (Task 3).
- Produces: production serves `/embed` with
  `frame-ancestors chrome-extension://<id>`; CI fails if manifest key and fly
  allowlist ever drift apart.

- [ ] **Step 1: Write the failing test**

In `test_fly_config.py`, add to `TestFlyConfigYaml`:

```python
    def test_embed_allowlists_exactly_the_pinned_extension(self, fly_settings):
        # Cross-pin (B43 C2, #134): the allowlist entry must be derived from
        # clients/browser-extension/public/manifest.json's "key", so rotating
        # the key without updating the deployment config fails CI here, not
        # at a user's side panel. Chromium's ID scheme: sha256 over the DER
        # public key, first 16 bytes, each nibble mapped 0-15 -> a-p (the
        # JS twin lives in clients/browser-extension/scripts/extension-id.mjs).
        import base64
        import hashlib
        import json

        manifest = json.loads(
            (
                REPO_ROOT / "clients" / "browser-extension" / "public" / "manifest.json"
            ).read_text(encoding="utf-8")
        )
        digest = hashlib.sha256(base64.b64decode(manifest["key"])).digest()
        expected = "".join(
            "abcdefghijklmnop"[nibble]
            for byte in digest[:16]
            for nibble in (byte >> 4, byte & 0xF)
        )
        assert fly_settings.embed.allowed_ancestors == [
            f"chrome-extension://{expected}"
        ]
```

- [ ] **Step 2: Run to verify failure** —
  `rtk proxy uv run pytest tests/test_fly_config.py -q` (from `backend/`):
  FAIL (allowlist empty).

- [ ] **Step 3: Add the config** — in `deploy/fly/config.yaml`:

```yaml
embed:
  # The unpacked C2 browser extension (B43): ID derived from the pinned
  # manifest key — guarded against drift by test_fly_config.py. Deploying
  # this change is config-only: `fly deploy --ha=false -c deploy/fly/fly.toml`
  # (no image bump needed; [[files]] re-delivers config.yaml).
  allowed_ancestors:
    - chrome-extension://<the ID printed by npm run ext-id>
```

- [ ] **Step 4: Run** — the test now passes; then cross-check the two
  implementations agree: `npm run ext-id` output equals the ID in the YAML.
  Full backend suite green, zero warnings.

- [ ] **Step 5: Mutation-verify** — change one character of the YAML entry —
  the test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add deploy/fly/config.yaml backend/tests/test_fly_config.py
git commit -m "feat(deploy): allowlist the pinned extension for /embed, cross-pin guard (B43 C2)"
```

---

### Task 12: Documentation

**Files:**
- Create: `docs/browser-extension.md`
- Modify: `docs/frontend-architecture.md`, `docs/backend-architecture.md`,
  `README.md` (one pointer line)

**Interfaces:** none — prose. Sources of truth: the spec + the code as built.

- [ ] **Step 1: Write `docs/browser-extension.md`** with these sections:
  **Architecture** (the three contexts + registry/relay diagram in prose,
  panelHost as the single Chromium-only seam, the two build passes and WHY the
  content script is one IIFE — ruling 1); **Install (unpacked)** (build
  commands, `chrome://extensions` steps, the pinned-ID property and what the
  server must allowlist, why the discarded private key forecloses nothing — a
  store release gets a store-assigned identity, options-page URL setup incl.
  `http://localhost:8000` for dev against the owner's running stack, the
  toolbar-icon fallback for opening the panel — `openPanelOnActionClick`, and
  the autofocused-composer note: a field focused before any interaction shows
  its chip immediately via the startup activeElement check); **Development** (watch builds,
  test commands, the shared-source rule with `frontend/src`); **E2E** (how
  `npm run e2e` works, ports 8100/8101, HEADFUL fallback); **Manual acceptance
  checklist — GitHub** (the spec's benchmark, as checkboxes): issue
  description box: connect, type, findings, overlay alignment on wrapped
  lines, apply suggestion, Cmd+Z restores; PR comment box: same; Turbo
  navigation away and back auto-disconnects and allows reconnect; long
  scrolling comment keeps overlay aligned while scrolling; markdown-heavy text
  offsets stay correct; page layering intact after connect — the adapter sets
  `position:relative`/`z-index:1` on the host field, which creates a stacking
  context on someone else's page: check GitHub's toolbars, dropdowns, and
  @-mention autocomplete still paint above the composer; sign-out in panel flips the affordance to signed-out;
  browser restart keeps the login (partitioned storage).
- [ ] **Step 2: Update the architecture docs** — frontend doc: extension
  package section + which `frontend/src` modules are shared exports now (and
  that `textareaAdapter.ts` carries the host-page contract since Task 6);
  backend doc: IPv6 bracket-literal ancestors (REMOVE its "no IPv6 literals
  (yet)" clause — same sync as `config.example.yaml` in Task 1) + the fly
  cross-pin guard.
- [ ] **Step 3: Commit**

```bash
git add docs/browser-extension.md docs/frontend-architecture.md docs/backend-architecture.md README.md
git commit -m "docs: browser extension architecture, unpacked install, acceptance checklist (B43 C2)"
```

---

## Final verification (before the PR)

- [ ] All gates: backend pytest (zero warnings), frontend
  test/lint/build/check:embed, extension lint/test/build.
- [ ] `npm run e2e` green on the composed HEAD.
- [ ] `git rebase main` if main moved; re-run gates after.
- [ ] PR `b43-c2-extension` → `main`: body references `Part of #134` (tick the
  C2 checkbox in #134 after merge), notes the two spec rulings (IIFE content
  script, delegation detection) so reviewers see them as decisions, requests
  Copilot review; spawn the review watcher per house convention.

## Explicitly deferred (do not implement)

- `chrome.storage.session`-backed registry survival across SW kills (noted in
  a code comment, Task 5).
- `<input type="text">` detection (needs an input-capable adapter variant).
- Chrome Web Store packaging/review pass; Firefox (C4) beyond the panelHost
  seam; contentEditable (C3).
- Ledger persistence of the `client` tag (deferred with B41 #126 → #135).
