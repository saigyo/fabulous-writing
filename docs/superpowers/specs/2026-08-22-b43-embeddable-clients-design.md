# B43: Embeddable Clients — Design

**Date:** 2026-08-22
**Status:** Approved concept, pre-implementation
**Scope:** The overall embedding architecture, plus the concrete design of slice C1
(embed surface + bridge protocol) and C2 (Chromium browser extension). Slices C3–C5
and the IDE hosts are roadmap-level here and get their own specs on pickup.

## Goal

Let Fabulous Writing be used from inside other applications — web browsers first,
JetBrains IDEs and Visual Studio Code later — with the *same* login, profile/
language/domain/LLM selection, check triggering, and findings sidebar (including
suggestion interaction) as the full app. The service serves the UI; the client/
plugin's only job is host integration: extract text from the host's editing
surface, hand it to the sidebar, draw markings where the host allows, and apply
replacements when the user picks a suggestion.

**Primary v1 consumer:** a browser extension for arbitrary sites (Chromium,
unpacked/developer-mode). **Acceptance benchmark:** GitHub issue/PR description
and comment boxes.

## Non-goals (v1)

- No document persistence from embedded contexts — checked text is ephemeral.
- No public self-signup, no API-key story; the existing invitation-only accounts
  log in through the existing auth endpoints.
- No Chrome Web Store distribution (revisit much later; the design must not
  *preclude* it — see the remote-code constraint below).
- No in-panel invite acceptance or password recovery — those email links target
  the main app and are completed there.

## Decisions from the brainstorm

| Question | Decision |
|---|---|
| Browser client kind | Extension for arbitrary sites (not a site-owner SDK) |
| Sidebar placement | Browser side panel (option A) + light in-page affordances near fields (option C), sider.ai-style. No injected iframe panels (per-site CSP fights, storage partitioning would force per-site re-login) |
| Field types v1 | `<textarea>`/`<input>` first; `contentEditable` designed-for now (capability model, adapter interface), implemented in C3; embedded editors (CodeMirror/Monaco/…) are a later plugin point |
| Interaction model | Explicit connect per field, then auto-check with the existing debounce (1 s → rules/terminology, 5 s → LLM) gated by the existing auto-LLM toggle |
| Browser roadmap | Chromium unpacked → Firefox (C4) → Safari (C5). DuckDuckGo desktop has no general extension system; its macOS build is WebKit, so the Safari leg is the realistic route there |
| UI delivery | Server-served embed page in an iframe + `postMessage` bridge (approach 1). Rejected: per-host native UI (forks the UI, needs CORS + token storage per host) and server-loaded JS bundles (remote hosted code — banned by Chrome Web Store MV3 policy, dissolves auth isolation) |

## Architecture overview

Four components; 1 and 2 are shared by every host, 3 is per-host:

1. **Embed surface** (this repo): a second frontend entry at `/embed/` — login
   gate + header selectors + findings sidebar, no editor/documents/admin — with a
   **host document shim** in place of CodeMirror.
2. **Bridge protocol**: a versioned `postMessage` JSON contract, the *only*
   coupling between server UI and hosts. Hosts never see tokens or call the API;
   the embed never sees the host DOM.
3. **Browser extension** (`clients/browser-extension/` in this repo while the
   protocol is young — protocol and extension changes land in one PR): MV3
   side-panel host + content-script field adapters.
4. **Later hosts**: VS Code webview, JetBrains JCEF, Firefox/Safari variants —
   each re-implements only component 3.

Data flow: field adapter extracts text → panel relays to iframe → embed runs the
existing check pipeline (same-origin inside the iframe → **no CORS anywhere**) →
findings render in the sidebar and stream back over the bridge as marking spans →
adapter draws overlays → user picks a suggestion → embed sends a replacement
command → adapter applies it to the field and echoes the new text back.

## Embed surface (C1)

### Frontend

- **Second Vite entry**, multi-page build: `index.html` (unchanged) + `embed.html`
  in the same `dist/`. The embed compos­es existing modules — `LoginGate`, profile/
  language/domain/LLM selectors with auto-LLM toggle, `Sidebar`, check controller +
  scheduler, SSE client, i18n — in a narrow single-column layout. Document
  manager, editor, and admin views are not imported (tree-shaken). The zustand
  store stays shared and unmodified; unused fields lie dormant.
- **Host document shim** replaces `editorRef.ts`/CodeMirror in the embed build:
  - Holds the connected field's text as a plain buffer, updated from bridge
    `textChanged` events. Hosts always send **full text**; the shim derives a
    minimal changeset (common prefix/suffix diff) — adapters stay trivial, the
    clever part lives in one shared place.
  - Ports the `findingsField` semantics against that changeset: map each tracked
    finding's `from`/`to` through the diff; drop findings whose span was directly
    edited or collapsed to zero length. Same rules as `editor/findings.ts`,
    plain-text implementation.
  - Implements the sidebar's three-function interface: `applySuggestion`/
    `applyRewrite` become bridge `applyReplacement` commands (the *host* mutates
    the field; the shim treats nothing as applied until the `replaceResult` echo
    confirms it); `selectFinding` highlights in the sidebar and sends
    `selectFinding` to the host to scroll/flash the overlay.
  - Feeds the existing debounce scheduler from `textChanged` instead of
    CodeMirror updates.
  - Owns the **code-point → UTF-16 offset conversion** (see protocol) using the
    checked-text snapshot it holds.

### Backend

1. The static catch-all serves `embed.html` for `/embed` and `/embed/*` (same
   exact-file-or-fallback pattern as today; `/api` precedence untouched).
2. **`Content-Security-Policy: frame-ancestors …`** from a new config list
   (env `FW_EMBED_ALLOWED_ANCESTORS`, entries like `chrome-extension://<id>`).
   Default empty → the embed route sends `frame-ancestors 'none'` and embedding
   is effectively off. Main-app routes send `frame-ancestors 'none'`
   unconditionally — embeddability and clickjacking hardening land in the same
   commit. Entries are validated at startup (same spirit as the trusted-proxies
   guard); malformed entries fail boot.
3. Optional **`client` tag** on `CheckRequest` (`"web"` default,
   `"browser-extension"`, later `"vscode"`, `"jetbrains"`), enum-validated,
   recorded in the usage ledger so activity diagrams can attribute traffic.

## Bridge protocol (normative)

Envelope: `{ fw: <protocolVersion:int>, type: string, requestId?: string,
payload: object }`.

Lifecycle: the embed waits for the host's `hello`, **pins `event.source` and
`event.origin` from that first message**, and ignores all other senders
thereafter (defense in depth on top of `frame-ancestors`). It answers `ready`.
Version policy: single integer; the embed keeps compatibility with N−1;
optional features are gated by capability flags, never by version sniffing.
No token or credential ever crosses the bridge — only text, findings geometry,
and commands.

**Offsets: UTF-16 code units**, normative for every host. Both v1 endpoints are
JavaScript; VS Code offsets and Java strings are UTF-16-native too. The backend
emits Python code-point offsets; the embed shim converts. (This fixes, for the
embed path, the latent astral-character desync the main app also has; the main
app fix is a spun-off backlog item.)

Host → embed:

| type | payload |
|---|---|
| `hello` | host kind/version; per-field capabilities: `mark: overlay\|native\|none`, `replace: reliable\|best-effort\|none` |
| `fieldConnected` | `fieldId`, full `text`, `meta` (page URL, field kind). Connecting a new field replaces the previous one — one connected field at a time in v1 |
| `textChanged` | `fieldId`, full text |
| `replaceResult` | `requestId`, `ok`, resulting full text — mandatory echo for every replacement |
| `markingClicked` | `fieldId`, finding `id` (only when the host declared interactive markings) |
| `fieldDisconnected` | `fieldId` |

Embed → host:

| type | payload |
|---|---|
| `ready` | protocol version, feature list |
| `status` | `phase` (idle/checking/llm-running/error/signed-out) + finding counts — drives the affordance badge |
| `findings` | `fieldId`, array of `{id, from, to, severity, category}` — geometry only; messages/suggestions render in the sidebar |
| `applyReplacement` | `requestId`, `fieldId`, `from`, `to`, `insert`, `expectedText` — the exact text believed to occupy `[from,to)`; the adapter MUST verify `expectedText` before mutating and refuse otherwise. Answered by `replaceResult` |
| `selectFinding` | `fieldId`, `id` — host scrolls/flashes that overlay |

Message types live in one **shared TS module** imported by both the embed and
the extension, so a breaking protocol change fails compilation, not runtime.

## Browser extension (C2)

MV3, Chromium. Cross-browser hygiene from day one: `webextension-polyfill`; no
Chromium-only API outside the panel-host module and the manifest.

1. **Scout content script** (small; `host_permissions: <all_urls>` — acceptable
   unpacked, revisit for store release). Finds eligible fields (visible
   `<textarea>` above a minimum size in v1), shows the connect affordance on
   focus/hover — shadow-DOM-isolated. Detection runs off a `MutationObserver`
   (GitHub Turbo navigation). Adapter code loads lazily on connect.
2. **Field adapters**, one interface (this is the C3/IDE preparedness point):

   ```ts
   interface FieldAdapter {
     capabilities(): {mark: 'overlay'|'native'|'none',
                      replace: 'reliable'|'best-effort'|'none'}
     extract(): string
     onChange(cb: () => void): void          // feeds textChanged
     applyReplacement(from: number, to: number, insert: string,
                      expectedText: string): {ok: boolean, text: string}
     setMarkings(spans: MarkingSpan[]): void
     clearMarkings(): void
     flashFinding(id: string): void          // selectFinding target
     dispose(): void
   }
   ```

   (`MarkingSpan` is the `findings` payload element: `{id, from, to, severity,
   category}`.)

   `TextareaAdapter` (v1): `value`-based extract; replacement via
   `setRangeText` so the field's undo history survives (`replace: 'reliable'`);
   markings via a mirror-overlay div replicating text, font metrics, and scroll
   position behind the textarea (`mark: 'overlay'`). `ContentEditableAdapter`
   (C3): CSS Custom Highlight API for markings, `Range`-based best-effort
   replacement — same interface, nothing outside the adapter changes.
3. **Panel host page** (extension origin, opened via `chrome.sidePanel`; the
   affordance click supplies the required user gesture). Contains the embed
   iframe; `src` from extension options (`chrome.storage`: server URL, default
   the hosted instance, switchable to `http://localhost:8000` for dev). Its only
   logic is the relay: `chrome.runtime` port ↔ `window.postMessage`, protocol
   passes through untranslated. All `chrome.sidePanel` calls live in a thin
   **panel-host abstraction module** — Firefox (`sidebar_action`) and Safari
   (no sidebar API → injected overlay panel or popup window) swap that module.
4. **Service worker**: tab↔panel routing and the connection registry. One
   connected field per browser window, bound to its tab; survives tab switches
   (panel header names the connected page/field); dies with the tab or on
   explicit disconnect.

**Manifest pins a `key`** so the unpacked extension ID — and therefore the
server's `FW_EMBED_ALLOWED_ANCESTORS` entry — is stable across machines and
installs.

## Auth

- Login happens entirely inside the iframe via the existing `LoginGate` →
  `POST /api/auth/login`; tokens live in the server origin's `localStorage`
  inside the iframe. Extension and host page can never read them.
- Side-panel partition key is `(chrome-extension://<id>, server origin)` —
  stable regardless of the visited site: one login per browser profile,
  surviving restarts, refreshed by the existing refresh loop. On hard expiry
  `expireSession` fires inside the embed; the panel shows the login form; the
  `status` message reflects signed-out for the affordance badge.
- "Forgot password" in the embed links out to the main app (new tab).

## Security & privacy rules

- The scout reads field *presence and geometry* only. Field text is read only
  after explicit connect; it leaves the browser only to the configured server,
  only when a check runs — the same trust boundary as typing in the app.
- No request from the iframe goes anywhere but the server (Supabase stays
  backend-proxied). No token, credential, or header material crosses the bridge.
- `frame-ancestors` allowlist default-off; embed origin-pins its host after the
  first `hello`.
- `expectedText` verification before every replacement guards against
  desync-driven text corruption in the host field.

## Testing

- **Backend (pytest, mutation-verified):** embed serving paths + `/api`
  precedence; `frame-ancestors 'none'` defaults on embed and main-app routes;
  configured allowlist rendering; malformed ancestor entries fail boot; `client`
  tag validation and ledger recording; fly-config guard if the env var ships
  there.
- **Embed (vitest):** shim diff derivation; offset mapping/drop semantics
  (porting the `editor/findings.ts` cases so both implementations provably share
  behavior); code-point→UTF-16 conversion with astral characters; replacement
  round-trips incl. `expectedText` mismatch and missing-echo timeout; bridge
  origin pinning, foreign-origin rejection, version negotiation.
- **Extension (vitest + Playwright):** adapter logic unit-tested; overlay
  geometry via e2e. E2E loads the extension with `--load-extension` against a
  **local fixture page** (not live GitHub) and the dev backend/e2e stack:
  connect → login in panel → type → findings → overlays → apply suggestion →
  field text replaced and re-checked. Playwright cannot drive the side panel
  itself; tests open `panel.html` as a normal extension page in a tab (the
  panel-host abstraction makes this equivalent).
- **Acceptance:** manual checklist on real GitHub issue/PR boxes — Turbo
  navigation, long scrolling comments, markdown-heavy text.

## Iteration slicing

| Slice | Content | Exit criterion |
|---|---|---|
| **C1** | Embed surface, shim, shared protocol module, backend serving + CSP config + `client` tag, **host simulator** (dev/test page with a textarea + reference `TextareaAdapter` embedding the iframe) | Full check/suggest/replace loop works in the simulator; e2e green |
| **C2** | Chromium extension MVP: scout, affordance, textarea adapter (lifted from the simulator), overlay markings, panel host + relay, options page, pinned key | GitHub issue/PR acceptance checklist passes; unpacked install documented |
| **C3** | `ContentEditableAdapter` | Works without protocol or embed changes — the capability model's proof |
| **C4** | Firefox port: `sidebar_action` panel-host module, manifest split | Same acceptance checklist on Firefox |
| **C5** | Safari port: Xcode-wrapped Web Extension, injected-panel host variant | Same checklist on Safari |
| Later | VS Code (webview + decorations), JetBrains (JCEF + editor markup) — separately brainstormed; same protocol | — |

C1 carries the design risk (shim semantics, protocol shape); everything after is
adapters and packaging. Each slice enters the backlog as a GitHub issue and runs
the house spec→plan→PR cycle.

## Future: social login (recorded, out of scope)

Supabase-backed OAuth providers (Google, GitHub, …) are anticipated but not part
of any C-slice. The design already composes with them; three notes keep it that
way:

- **Flow shape:** OAuth cannot run inside the embed iframe (providers block
  framing; tab-completed logins don't reach the iframe's storage partition).
  The path is a **popup at the server origin** opened by the embed's login UI:
  top-level window completes the backend-proxied flow, then hands the session to
  its opener via same-origin `postMessage`. Tokens still never touch the host.
  Provider/redirect registration is server-origin only — host-independent.
- **Normative now:** hosts MUST embed the iframe unsandboxed, or with at least
  `allow-popups`, `allow-same-origin`, `allow-scripts`, and `allow-forms` — so
  the popup path stays open.
- **IDE hosts later:** JCEF/VS Code webviews can't `window.open`; the flow there
  is "host opens system browser + handoff back", added as an optional host
  capability (e.g. `openExternal`) via the protocol's capability flags — no
  breaking change.

## Spun-off backlog items (out of scope here)

- Main app's code-point vs UTF-16 astral-character desync between backend spans
  and CodeMirror positions.
- Store slimming / embed bundle diet, only if measurements demand it.
- Chrome Web Store packaging and review-compliance pass.
