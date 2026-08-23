# Browser extension (B43 C2)

Design source: `docs/superpowers/specs/2026-08-22-b43-embeddable-clients-design.md`.
The extension (`clients/browser-extension/`) is the first host client of the
embed surface documented in [frontend-architecture.md](frontend-architecture.md#embed-surface-b43-c1):
a Chromium MV3 extension that finds eligible textareas on arbitrary sites,
opens a side panel hosting the server's `/embed` page in an iframe, and relays
the bridge protocol between the two. Acceptance benchmark: GitHub issue/PR
description and comment boxes.

## Architecture

Three contexts, wired by a fourth Chromium-only piece:

- **Content script (scout)** — `src/scout.ts`, one instance per tab/page.
  Delegates `focusin`/`focusout`/`mouseover`/`mouseout` at the document level
  (all four bubble, unlike `mouseenter`/`mouseleave`, so this works without a
  `MutationObserver` scanning the page — a Turbo-injected field is noticed the
  moment it's interacted with) and shows a shadow-DOM-isolated connect chip
  (`src/affordance.ts`) near an eligible field (`src/detect.ts`: a visible,
  enabled, writable `<textarea>` at least 120×40px — `<input>` is out of scope
  for v1, see below). Clicking the chip starts a **session**
  (`src/session.ts`), which owns one field's adapter (lifted straight from the
  C1 host simulator's reference implementation,
  `frontend/src/simulator/textareaAdapter.ts`) and speaks the bridge protocol
  over a lazily-opened `browser.runtime` port.
- **Service worker** — `src/sw.ts`. Wires real ports to a pure state machine,
  `src/registry.ts` (the **connection registry**): one connected field per
  browser window, bound to its tab, routed by port name (`'field'` from the
  content script, `'panel'` from the side panel) rather than by inspecting
  message content. The registry returns `Effect[]` (send to panel/field/badge)
  that `sw.ts` executes against the live ports — this is what makes the
  routing rules (same-tab replace, cross-tab replace sends the losing tab a
  `detach`, panel-not-ready buffers nothing and re-synthesizes `fieldConnected`
  on the next `embedReady`) unit-testable without mocking a single port. The
  registry is in-memory; MV3's service worker stays alive as long as any port
  is connected, so state survives idle-suspend/wake and is lost only on an
  extension update or SW crash — the scout's reconnect-on-next-interaction is
  the recovery path (`chrome.storage.session`-backed registry survival is
  deferred, noted in a code comment in `registry.ts`/`sw.ts`).
- **Panel host page** — `panel.html` + `src/panel.ts`/`src/relay.ts`, opened
  via `chrome.sidePanel`. Contains the embed iframe; its only logic is the
  relay — `chrome.runtime` port traffic ↔ `window.postMessage` to the iframe,
  protocol envelopes passed through **untranslated**. `src/relay.ts` also owns
  the `hello` handshake retry loop (250ms, capped at 30 attempts — long enough
  for a slow dev-server cold start without leaving the panel silently stuck)
  and is deliberately polyfill-free so it stays unit-testable with fake
  timers.
- **`src/panelHost.ts`** — the single Chromium-only seam. Every other module
  imports only `webextension-polyfill`; this one file makes the three
  `chrome.sidePanel`/`chrome.action` calls the extension needs
  (`setPanelBehavior`, `sidePanel.open`, `action.setBadgeText`). Firefox (C4)
  swaps this file for a `sidebar_action` variant with no other module
  touched.

Data flow: scout shows the chip → click starts a session → the adapter
extracts text and sends `fieldConnected`/`textChanged` through the SW to the
panel → the panel relays into the embed iframe → the embed runs the existing
check pipeline (same origin inside the iframe, no CORS) → findings stream back
as `findings` (marking spans) → the adapter draws overlays → picking a
suggestion sends `applyReplacement`, the adapter applies it via
`document.execCommand('insertText', ...)` — the same code path a real
keystroke or paste goes through, so the field's native undo history survives
(Cmd+Z restores the field's own edit stack); `setRangeText` is only a
fallback for environments without `execCommand` (there's no undo stack to
preserve there either) — and echoes `replaceResult`.

### Two build passes, one IIFE content script

`npm run build` runs `vite build` twice against two configs:

- `vite.config.ts` — the ESM pass: service worker (`type: module` in the
  manifest), `panel.html`, `options.html`. Stable, hash-free output filenames
  (`sw.js`, `panel.js`, `options.js`) because the manifest references them
  literally.
- `vite.content.config.ts` — the content-script pass, `emptyOutDir: false` so
  it *adds* `scout.js` to the same `dist/` the first pass just wrote. It
  builds `src/scout.ts` as a single classic **IIFE**, not ESM.

**Ruling 1 (why one IIFE):** a content script's dynamic `import()` is subject
to the *host page's* Content-Security-Policy, not the extension's own — a
site with a strict CSP would silently break the extension the moment it tried
to lazy-load a chunk. Building the whole content script as one
statically-linked IIFE with no runtime imports sidesteps that entirely; it's
the only context in the extension with this constraint (the service worker
and panel/options pages run in extension-controlled contexts, so their normal
ESM chunking is fine).

## Install (unpacked)

```sh
cd clients/browser-extension && npm run build  # extension -> clients/browser-extension/dist
```

This only builds the extension itself; it never bundles the frontend/embed
surface, which is served by whichever server the options page points at (see
below) — the hosted default needs no build of your own. Building
`frontend/dist` locally is only needed when the server you're pointing at is
your own single-origin backend (`frontend.dist_dir` configured, see
[backend-architecture.md](backend-architecture.md#container-deployment-b17)):
in that case build it with `cd frontend && VITE_API_URL="" npm run build`
(the E2E section below explains why `VITE_API_URL=""` matters whenever the
embed is served from anything other than `localhost:8000`).

Then in Chrome/Chromium:

1. `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. **Load unpacked** → select `clients/browser-extension/dist`

### The pinned ID

`public/manifest.json` pins a `key` (the extension's DER public key,
base64-encoded). Chromium derives the extension ID from it deterministically
— sha256 over the decoded key, first 16 bytes, each nibble mapped to a
letter `a`–`p` — so the unpacked extension gets the **same ID on every
machine and every reinstall**: `llflkhlppiamgpmmaheccjjhccjlhbpf`. Run
`npm run ext-id` (`scripts/extension-id.mjs`) to print it yourself; the same
six-line derivation is reimplemented in Python by
`backend/tests/test_fly_config.py`, which cross-pins it against
`deploy/fly/config.yaml`'s `embed.allowed_ancestors` entry so a rotated key
that isn't also updated in the deployment config fails CI instead of a
user's side panel.

The server must allowlist this exact origin, `chrome-extension://<id>`, in
its `embed.allowed_ancestors` config (see
[backend-architecture.md](backend-architecture.md) — `embed.allowed_ancestors`
is what the embed route's `frame-ancestors` CSP directive is built from;
without an allowlist entry the browser refuses to frame `/embed` at all, key
or no key).

The private key that produced this `key` field was generated once and then
discarded — this **forecloses nothing**. A future Chrome Web Store release
gets its own store-assigned identity (the store re-signs the package and
issues a new, store-controlled ID) that has no relationship to the pinned
unpacked ID; the pinned key exists purely to keep *this* development/unpacked
ID stable across machines and reinstalls, not to reserve a permanent
identity.

### Options page: server URL

Open the extension's options page (`chrome://extensions` → the extension's
**Details** → **Extension options**, or the panel's own **Options** button).
Set **Server URL** to whichever server you're checking against:

- The hosted default (`DEFAULT_SERVER_URL` in `src/settings.ts`,
  `https://fabulous-writing.fly.dev`) needs no change.
- `http://localhost:8000` points the panel at your own locally-running
  backend (the owner's usual `uv run uvicorn app.main:app --reload --port
  8000` dev stack) — set this when developing against a local server. Only
  an `http://`/`https://` origin (no path, query, or fragment) is accepted;
  an invalid value shows a validation message instead of saving.

The panel reloads on save (its own `onServerUrlChanged` listener), so no
manual extension reload is needed.

### Toolbar-icon fallback

`chrome.sidePanel.open()` requires an active user gesture; the affordance
chip supplies one because the click that opens it is itself the gesture, sent
synchronously (no `await` ahead of the call) through the port message
handler. As a second path that needs no such synchronous gesture threading,
`src/panelHost.ts` also calls `chrome.sidePanel.setPanelBehavior({
openPanelOnActionClick: true })` once at service-worker startup: clicking the
extension's **toolbar icon** always opens the panel directly, independent of
any field or affordance.

### Autofocused-composer note

Most fields only become eligible for the chip on hover or focus (the
document-level delegated listeners in `scout.ts`). A field that is *already*
focused when the page finishes loading — an autofocused composer box, for
instance — would otherwise show no chip until the user happened to
hover/refocus it. `scout.ts` runs a one-shot startup check
(`isEligibleField(document.activeElement)`) and shows the chip immediately if
the page loaded with such a field already focused.

## Development

```sh
cd clients/browser-extension
npm run build   # tsc --noEmit + both vite build passes -> dist/
npm test        # vitest run (happy-dom)
npm run lint    # oxlint
```

There's no `dev`/watch script; iterate with `npm run build` and Chrome's
"Reload" button on the unpacked extension (`chrome://extensions`).

**Shared source with `frontend/src`.** The extension does not duplicate the
embed protocol or the reference field adapter — it imports them directly by
relative path from the sibling `frontend/` package (no publish/link step):
`../../../frontend/src/embed/protocol` (the versioned bridge contract) and
`../../../frontend/src/simulator/textareaAdapter`/`clickHitTest` (the
`FieldAdapter` implementation and its click-hit-test helper). A protocol
change that breaks the extension's usage fails `tsc --noEmit` here, not at
runtime. See [frontend-architecture.md](frontend-architecture.md#embed-surface-b43-c1)
for what each shared module does on the embed side of the same contract.

## E2E

```sh
cd frontend && VITE_API_URL="" npm run build   # NOT plain `npm run build`
cd clients/browser-extension && npm run build
npm run e2e
```

`e2e/run.mjs` orchestrates the whole thing locally (it is **not** part of
CI — it boots a real backend): a throwaway backend on port **8100** (`uv
--directory backend run uvicorn app.main:app --port 8100`, against a tmp
SQLite DB and a generated `config.yaml` whose `embed.allowed_ancestors`
allowlists the extension ID derived from `public/manifest.json`), and a
static file server for `e2e/fixture.html` on port **8101**. Ports 8100/8101
are deliberately never 5173/8000 (the owner's own dev servers); the script
aborts rather than killing whatever holds either port. `e2e/extension.spec.mjs`
then drives the real 10-step flow with `playwright-core` and
`--load-extension`: fixture page affordance → options page → connect → login
inside the embed iframe → type → finding renders → overlay + apply → chip
state → disconnect.

**`VITE_API_URL=""` is required**, not optional, when building the frontend
for this e2e run. `frontend/src/api/client.ts`'s API base falls back to the
literal `http://localhost:8000` whenever `VITE_API_URL` is unset at build
time — correct for the frontend's own normal two-origin dev flow (5173 →
8000), but fatal here: the embed is served *by* the e2e's own throwaway
backend (8100), and a build with the baked-in fallback tries to log in
against a backend this e2e never starts, which times out with a generic
"sign-in failed" and no server-side request at all. `run.mjs`'s own preflight
greps the built `frontend/dist/assets/*.js` for the `://localhost:8000`
literal and fails immediately with this exact fix if it finds it, rather than
letting the failure surface later as an opaque login timeout.

Playwright cannot drive Chrome's real side panel UI directly; the panel-host
abstraction (`src/panelHost.ts`) makes opening `panel.html` as a plain
extension page in a tab equivalent for test purposes, which is what
`extension.spec.mjs` does.

Set `HEADFUL=1 npm run e2e` to run with a visible browser window instead of
headless — implemented and available, not needed for routine runs.

## Manual acceptance checklist — GitHub

The spec's acceptance benchmark. Run against a real `github.com` issue or PR,
with the extension loaded unpacked and its options pointed at a running
server.

**Issue description box:**

- [ ] Hover/focus the box; the connect chip appears; clicking it opens the
      side panel and the box shows the connected/busy state
- [ ] Type text; a finding appears in the panel's sidebar
- [ ] The overlay mark aligns with the flagged text, including across
      **wrapped lines** (not just the first line of a long paragraph)
- [ ] Apply a suggestion from the panel; the box's text updates and the mark
      clears
- [ ] **Cmd+Z** (or Ctrl+Z) in the box restores the pre-apply text — the
      replacement went through `execCommand('insertText', ...)`, so it's a
      normal entry in the field's native undo history, not a scripted
      overwrite

**PR comment box:** same five checks as the issue description box above.

**Turbo navigation:**

- [ ] Navigate away from a page with a connected field (GitHub's Turbo
      client-side navigation) — the session auto-disconnects (the field
      element leaves the document; `session.ts`'s `MutationObserver`
      notices and stops the session) rather than leaking a session no page
      can reach
- [ ] Navigate back to a field and reconnect — a fresh chip, fresh session,
      no stale panel state

**Long scrolling comment:**

- [ ] Type or paste enough text that the comment box scrolls internally;
      confirm the overlay stays aligned with the underlying text while
      scrolling — including inside an **inner scrollable container** (the
      adapter's overlay is repositioned by a captured, document-level
      `scroll` listener with `capture: true`, so a scroll event on an
      unpositioned ancestor that doesn't bubble still triggers a re-sync)

**Markdown-heavy text:**

- [ ] Type markdown-heavy content (headings, code spans, links, lists);
      confirm finding offsets stay correct against the raw markdown source
      GitHub actually stores (not a rendered preview)

**Page layering:**

- [ ] After connecting a field, confirm the rest of the page still layers
      correctly: the adapter sets `position: relative`/`z-index: 1` on the
      host field when it doesn't already have an explicit stacking position,
      which creates a **new stacking context** on someone else's page — check
      that GitHub's own toolbars, dropdowns, and the **@-mention
      autocomplete** popover still paint above the composer, not underneath
      the mirror overlay

**Sign-out and session persistence:**

- [ ] Sign out from the panel's account menu; the chip/panel affordance flips
      to the signed-out state
- [ ] Restart the browser; the login persists (the side panel's storage
      partition — `(chrome-extension://<id>, server origin)` — is stable
      across restarts, independent of whichever site is open)
