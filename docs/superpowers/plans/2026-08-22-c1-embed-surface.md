# C1: Embed Surface + Bridge Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve an embeddable login+sidebar UI at `/embed/` with a versioned postMessage bridge, a host-document shim replacing CodeMirror, backend CSP/serving support, and a host-simulator page proving the full check→findings→replace loop.

**Architecture:** A second Vite entry composes existing auth/header/sidebar modules over a new host-document shim; a document-port indirection (same pattern as `checking/cancelSlot.ts`) lets `controller.ts`, `suggest.ts`, and `Sidebar.tsx` run against either CodeMirror or the shim. The backend serves `embed.html` under `/embed*` with a configurable `frame-ancestors` CSP, default-deny.

**Tech Stack:** React 19 + TS + Vite multi-page, zustand, vitest; FastAPI + pytest.

**Spec:** `docs/superpowers/specs/2026-08-22-b43-embeddable-clients-design.md`

**Branch:** `b43-embed-c1` (from `main`).

## Global Constraints

- Backend gate: `rtk proxy uv run pytest -q` from `backend/` — green, ZERO warnings. Frontend gate: `npm run test`, `rtk proxy npm run lint`, `npm run build` from `frontend/`.
- Mutation-verify every new guard test (delete/disable the guard, watch the test fail, restore by re-editing — never `git checkout <file>`).
- Never read/write `backend/data/`; tests use `tmp_path`-based `Settings`. Never touch ports 5173/8000.
- Secrets: names only, never values. No `dangerouslySetInnerHTML`; no dynamic `href`/`src`.
- Commit trailers on EVERY commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01JXiCFTQQmJeJt3MB8qZdGA`
- Protocol offsets are **UTF-16 code units** (spec, normative). Backend `Finding.span` offsets are Python code points; conversion happens ONLY in the embed shim (Task 4).
- New user-facing strings: informal register (Du/tu/tú), added to ALL 7 locales; the `Messages` interface makes omissions a compile error.
- i18n note: the three `embed*` strings are status text, not direct address; match each locale's existing status-message tone.
- **Scope ruling (deviation from spec, deliberate):** the `client` tag is added to the API (validated, default `"web"`) but NOT persisted — `llm_usage` has no `client` column and adding one is a schema change, which per house policy ships with the next schema-touching story together with B41's day-first index (#126). Task 9 documents this in code.

---

### Task 1: Bridge protocol module + FieldAdapter interface

**Files:**
- Create: `frontend/src/embed/protocol.ts`
- Test: `frontend/src/embed/protocol.test.ts`

**Interfaces:**
- Produces: `PROTOCOL_VERSION`, all message types below, `parseHostMessage(data: unknown): HostMessage | null`. Consumed by Tasks 4, 5, 7 and later by the C2 extension.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/embed/protocol.test.ts
import { describe, expect, it } from 'vitest'
import { parseHostMessage, PROTOCOL_VERSION } from './protocol'

describe('parseHostMessage', () => {
  it('accepts a well-formed hello', () => {
    const msg = parseHostMessage({
      fw: PROTOCOL_VERSION,
      type: 'hello',
      payload: { host: { kind: 'simulator', version: '0.0.1' } },
    })
    expect(msg?.type).toBe('hello')
  })

  it('rejects non-objects, missing fw, unknown types, wrong version', () => {
    expect(parseHostMessage(null)).toBeNull()
    expect(parseHostMessage('x')).toBeNull()
    expect(parseHostMessage({ type: 'hello', payload: {} })).toBeNull()
    expect(parseHostMessage({ fw: PROTOCOL_VERSION, type: 'nope', payload: {} })).toBeNull()
    expect(parseHostMessage({ fw: PROTOCOL_VERSION + 1, type: 'hello', payload: {} })).toBeNull()
  })

  it('rejects textChanged without string text', () => {
    expect(
      parseHostMessage({ fw: PROTOCOL_VERSION, type: 'textChanged', payload: { fieldId: 'f1' } }),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** — `npm run test -- protocol` → module not found.

- [ ] **Step 3: Implement**

```ts
// frontend/src/embed/protocol.ts
// The bridge contract between the embed page and any host (spec: B43,
// "Bridge protocol"). Offsets in every message are UTF-16 code units.
// This module is imported by both sides — a breaking change here fails
// compilation in the extension too, never at runtime.
import type { Category, Severity } from '../types'

export const PROTOCOL_VERSION = 1

export type MarkCapability = 'overlay' | 'native' | 'none'
export type ReplaceCapability = 'reliable' | 'best-effort' | 'none'

export interface HostCapabilities {
  mark: MarkCapability
  replace: ReplaceCapability
}

export interface MarkingSpan {
  id: string
  from: number
  to: number
  severity: Severity
  category: Category
}

// ---- host -> embed ----
export interface HelloMessage {
  type: 'hello'
  payload: { host: { kind: string; version: string } }
}
export interface FieldConnectedMessage {
  type: 'fieldConnected'
  payload: {
    fieldId: string
    text: string
    capabilities: HostCapabilities
    meta: { url: string; fieldKind: string }
  }
}
export interface TextChangedMessage {
  type: 'textChanged'
  payload: { fieldId: string; text: string }
}
export interface ReplaceResultMessage {
  type: 'replaceResult'
  requestId: string
  payload: { fieldId: string; ok: boolean; text: string }
}
export interface MarkingClickedMessage {
  type: 'markingClicked'
  payload: { fieldId: string; id: string }
}
export interface FieldDisconnectedMessage {
  type: 'fieldDisconnected'
  payload: { fieldId: string }
}
export type HostMessage =
  | HelloMessage
  | FieldConnectedMessage
  | TextChangedMessage
  | ReplaceResultMessage
  | MarkingClickedMessage
  | FieldDisconnectedMessage

// ---- embed -> host ----
export interface ReadyMessage {
  type: 'ready'
  payload: { protocolVersion: number; features: string[] }
}
export interface StatusMessage {
  type: 'status'
  payload: {
    phase: 'idle' | 'checking' | 'llm-running' | 'error' | 'signed-out'
    findingCount: number
  }
}
export interface FindingsMessage {
  type: 'findings'
  payload: { fieldId: string; findings: MarkingSpan[] }
}
export interface ApplyReplacementMessage {
  type: 'applyReplacement'
  requestId: string
  payload: {
    fieldId: string
    from: number
    to: number
    insert: string
    expectedText: string
  }
}
export interface SelectFindingMessage {
  type: 'selectFinding'
  payload: { fieldId: string; id: string | null }
}
export type EmbedMessage =
  | ReadyMessage
  | StatusMessage
  | FindingsMessage
  | ApplyReplacementMessage
  | SelectFindingMessage

export type Envelope<M> = M & { fw: number }

export function envelope<M extends EmbedMessage>(message: M): Envelope<M> {
  return { fw: PROTOCOL_VERSION, ...message }
}

const HOST_TYPES = new Set([
  'hello', 'fieldConnected', 'textChanged', 'replaceResult',
  'markingClicked', 'fieldDisconnected',
])

/** Validate an incoming postMessage payload. Returns null for anything that
 * is not a current-version host message with the fields its type requires —
 * the bridge drops those silently (foreign frames post all kinds of data). */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.fw !== PROTOCOL_VERSION) return null
  if (typeof d.type !== 'string' || !HOST_TYPES.has(d.type)) return null
  const p = d.payload
  if (typeof p !== 'object' || p === null) return null
  const pay = p as Record<string, unknown>
  switch (d.type) {
    case 'hello':
      if (typeof pay.host !== 'object' || pay.host === null) return null
      break
    case 'fieldConnected':
      if (typeof pay.fieldId !== 'string' || typeof pay.text !== 'string') return null
      break
    case 'textChanged':
      if (typeof pay.fieldId !== 'string' || typeof pay.text !== 'string') return null
      break
    case 'replaceResult':
      if (typeof d.requestId !== 'string' || typeof pay.ok !== 'boolean'
        || typeof pay.text !== 'string') return null
      break
    case 'markingClicked':
    case 'fieldDisconnected':
      if (typeof pay.fieldId !== 'string') return null
      break
  }
  return data as HostMessage
}

// ---- the host-side adapter contract (spec: "Field adapters") ----
// Lives here (not in the extension) so the simulator's reference adapter and
// every later host implement the same shape the protocol was designed for.
export interface FieldAdapter {
  capabilities(): HostCapabilities
  extract(): string
  onChange(cb: () => void): void
  applyReplacement(
    from: number, to: number, insert: string, expectedText: string,
  ): { ok: boolean; text: string }
  setMarkings(spans: MarkingSpan[]): void
  clearMarkings(): void
  flashFinding(id: string): void
  dispose(): void
}
```

- [ ] **Step 4: Run test, expect PASS.**
- [ ] **Step 5: Commit** — `feat(embed): bridge protocol module + FieldAdapter contract (B43 C1)`

---

### Task 2: Code-point → UTF-16 offset conversion

**Files:**
- Create: `frontend/src/embed/offsets.ts`
- Test: `frontend/src/embed/offsets.test.ts`

**Interfaces:**
- Produces: `convertFindingOffsets(text: string, findings: Finding[]): Finding[]` — input spans in code points (backend convention), output spans in UTF-16 units against the same `text`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/embed/offsets.test.ts
import { describe, expect, it } from 'vitest'
import type { Finding } from '../types'
import { convertFindingOffsets } from './offsets'

function finding(start: number, end: number, text: string): Finding {
  return {
    id: 'x', category: 'spelling', severity: 'error', source: 'rule',
    rule_id: null, message: 'm', span: { start, end, text },
    suggestions: [], advice: [],
  }
}

describe('convertFindingOffsets', () => {
  it('is identity for BMP-only text', () => {
    const [f] = convertFindingOffsets('hello world', [finding(6, 11, 'world')])
    expect(f.span).toEqual({ start: 6, end: 11, text: 'world' })
  })

  it('shifts spans after astral characters', () => {
    // '𝔸' is one code point but two UTF-16 units. Code points: 𝔸=0, space=1, bad=2..5
    const text = '𝔸 bad'
    const [f] = convertFindingOffsets(text, [finding(2, 5, 'bad')])
    expect(f.span.start).toBe(3)
    expect(f.span.end).toBe(6)
    expect(text.slice(f.span.start, f.span.end)).toBe('bad')
  })

  it('drops findings whose converted span text does not match', () => {
    expect(convertFindingOffsets('abc', [finding(0, 2, 'zz')])).toEqual([])
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

```ts
// frontend/src/embed/offsets.ts
import type { Finding } from '../types'

/**
 * Backend spans are code-point offsets (Python); the bridge protocol and the
 * shim work in UTF-16 units (spec B43). Convert against the checked-text
 * snapshot. Findings whose converted slice does not equal span.text are
 * dropped — the "spans are exact" invariant must hold after conversion too.
 */
export function convertFindingOffsets(text: string, findings: Finding[]): Finding[] {
  // Fast path: no astral characters -> code points == UTF-16 units.
  let map: number[] | null = null
  if (/[\uD800-\uDBFF]/.test(text)) {
    map = []
    let utf16 = 0
    for (const cp of text) {
      map.push(utf16)
      utf16 += cp.length
    }
    map.push(utf16) // end-of-text sentinel: span.end may equal text length
  }
  const out: Finding[] = []
  for (const f of findings) {
    const start = map ? map[f.span.start] : f.span.start
    const end = map ? map[f.span.end] : f.span.end
    if (start === undefined || end === undefined) continue
    if (text.slice(start, end) !== f.span.text) continue
    out.push({ ...f, span: { start, end, text: f.span.text } })
  }
  return out
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(embed): code-point to UTF-16 finding-offset conversion (B43 C1)`

---

### Task 3: Document port indirection (refactor, no behavior change)

**Files:**
- Create: `frontend/src/document/port.ts`
- Create: `frontend/src/editor/editorPort.ts`
- Modify: `frontend/src/checking/controller.ts` (all `getEditorView()`/dispatch sites)
- Modify: `frontend/src/checking/suggest.ts` (text + span reads)
- Modify: `frontend/src/sidebar/Sidebar.tsx` (3 imports from `editorRef` → `document/port`)
- Modify: `frontend/src/editor/Editor.tsx` (side-effect import of `editorPort`)
- Modify: `frontend/src/checking/controller.test.ts`, `frontend/src/checking/suggest.test.ts` (register a fake port instead of faking an EditorView)
- Test: existing suites are the net; add `frontend/src/document/port.test.ts` for registration semantics

**Interfaces:**
- Produces (consumed by Tasks 4, 5, 6):

```ts
// frontend/src/document/port.ts
// Leaf module (same pattern as checking/cancelSlot.ts): the checking layer
// and the sidebar talk to "the document" through this port; the main app
// registers a CodeMirror implementation (editor/editorPort.ts), the embed
// registers the host-document shim. No module imports both sides.
import type { Finding, Source } from '../types'

export interface DocumentPort {
  getText(): string
  /** Current mapped span of a finding, or null if it was dropped. */
  currentSpan(id: string): { from: number; to: number } | null
  /** Replace all findings of the given sources (no staleness check — the
   * caller compares getText() against its checked snapshot first). */
  mergeFindings(replaceSources: Source[], findings: Finding[]): void
  selectFinding(id: string | null): void
  /** Resolve true when the replacement was applied, false when it could not
   * be (span gone / sentence changed / host refused). */
  applySuggestion(id: string, suggestion: string): Promise<boolean>
  applyRewrite(id: string, original: string, replacement: string): Promise<boolean>
}

let port: DocumentPort | null = null
export function setDocumentPort(p: DocumentPort | null): void { port = p }
export function getDocumentPort(): DocumentPort | null { return port }
```

- [ ] **Step 1: Write `port.test.ts`** — `getDocumentPort()` returns null before registration, the registered instance after, null again after `setDocumentPort(null)`. Run: FAIL (module missing).
- [ ] **Step 2: Create `document/port.ts`** exactly as above; test PASSES.
- [ ] **Step 3: Create `editor/editorPort.ts`** — the CodeMirror implementation, registered at module load:

```ts
// frontend/src/editor/editorPort.ts
import type { DocumentPort } from '../document/port'
import { setDocumentPort } from '../document/port'
import { applyRewrite, applySuggestion, getEditorView, selectFinding } from './editorRef'
import { findingsField, mergeFindingsEffect } from './findings'

const cmPort: DocumentPort = {
  getText: () => getEditorView()?.state.doc.toString() ?? '',
  currentSpan(id) {
    const view = getEditorView()
    const item = view?.state.field(findingsField).items.find((it) => it.finding.id === id)
    return item ? { from: item.from, to: item.to } : null
  },
  mergeFindings(replaceSources, findings) {
    getEditorView()?.dispatch({
      effects: mergeFindingsEffect.of({ replaceSources, findings }),
    })
  },
  selectFinding,
  applySuggestion: (id, suggestion) => {
    const view = getEditorView()
    if (!view) return Promise.resolve(false)
    applySuggestion(id, suggestion)
    return Promise.resolve(true)
  },
  applyRewrite: (id, original, replacement) =>
    Promise.resolve(applyRewrite(id, original, replacement)),
}
setDocumentPort(cmPort)
```

- [ ] **Step 4: Rewire consumers.** Mechanical mapping, preserving every guard comment:
  - `controller.ts`: drop the `getEditorView`/`mergeFindingsEffect` imports; `const view = getEditorView(); if (!view) return` → `const port = getDocumentPort(); if (!port) return`; `view.state.doc.toString()` → `port.getText()`; the empty-text branch's dispatch → `port.mergeFindings(['rule', 'terminology', 'llm'], [])`; `applyFindings()` keeps its snapshot compare (`port.getText() !== checkedText → return`) then calls `port.mergeFindings(sources, findings)`; the `onScorecard` staleness check uses `port.getText()`.
  - `suggest.ts`: text via `port.getText()`, the finding's current span via `port.currentSpan(id)` (bail, as today, when null).
  - `Sidebar.tsx`: `import { applyRewrite, applySuggestion, selectFinding } from '../document/port'` becomes calls through `getDocumentPort()` — add a tiny local helper `const port = () => getDocumentPort()`; call sites `await port()?.applySuggestion(...)`; the rewrite call site keeps its false-branch UI (`Sidebar.tsx:396-412`) with `const ok = (await port()?.applyRewrite(...)) ?? false`.
  - `Editor.tsx`: add `import './editorPort'` (side-effect registration).
- [ ] **Step 5: Adapt `controller.test.ts` / `suggest.test.ts`** — replace EditorView fakes with `setDocumentPort(fakePort)` in setup and `setDocumentPort(null)` in teardown. The fake records `mergeFindings` calls and serves `getText`.
- [ ] **Step 6: Full frontend gate** — `npm run test`, `rtk proxy npm run lint`, `npm run build`. Everything green: this task changes NO behavior.
- [ ] **Step 7: Mutation check** — temporarily remove the snapshot compare in `applyFindings`; the existing stale-findings controller test must fail; restore.
- [ ] **Step 8: Commit** — `refactor(frontend): document-port indirection for checking + sidebar (B43 C1)`

---

### Task 4: Host document shim

**Files:**
- Create: `frontend/src/embed/hostDoc.ts`
- Test: `frontend/src/embed/hostDoc.test.ts`

**Interfaces:**
- Consumes: `DocumentPort` (Task 3), `convertFindingOffsets` (Task 2), `MarkingSpan`/`HostCapabilities` (Task 1), store `setTracked` (existing).
- Produces (consumed by Task 5):

```ts
export interface HostDocOutbound {
  sendApplyReplacement(msg: {
    requestId: string; fieldId: string; from: number; to: number
    insert: string; expectedText: string
  }): void
  sendSelectFinding(fieldId: string, id: string | null): void
  sendFindings(fieldId: string, findings: MarkingSpan[]): void
  onInput(): void // scheduler hook, wired by the embed app
}
export function createHostDoc(outbound: HostDocOutbound): HostDoc
export interface HostDoc extends DocumentPort {
  fieldConnected(fieldId: string, text: string, capabilities: HostCapabilities): void
  fieldDisconnected(fieldId: string): void
  textChanged(fieldId: string, text: string): void
  replaceResult(requestId: string, ok: boolean, text: string): void
  connected(): boolean
  capabilities(): HostCapabilities | null
}
```

Note: there is NO separate `mergeServerFindings` — the shim's `DocumentPort.mergeFindings`
implementation itself converts incoming spans via `convertFindingOffsets(buffer, findings)`
before tracking (the controller's snapshot guard guarantees the buffer equals the checked
text at that moment). The CodeMirror port keeps its existing unconverted behavior — that
latent astral bug is explicitly out of scope (Global Constraints / Deferred).

**Behavior spec (port of `editor/findings.ts` semantics to a single-splice world):**

- `textChanged` computes the minimal splice between old and new buffer: longest common prefix `p`, longest common suffix `s` over the remainder → old range `[p, oldLen - s)` replaced by new slice `[p, newLen - s)`. Guard `p + s` overshoot (`p = min(p, oldLen - s, newLen - s)` after computing `s` capped to `min(oldLen, newLen) - p`).
- Tracked findings map through the splice exactly like the CodeMirror field:
  - `item.to < spliceFrom` → unchanged; `item.from > spliceTo` → shift by `insertLen - (spliceTo - spliceFrom)`.
  - Any overlap **or adjacency** with the replaced range (`item.from <= spliceTo && spliceFrom <= item.to`) when the splice is a real change → drop (mirrors `touchesRange`, which counts touching boundaries).
  - Zero-length results drop.
- `mergeFindings` mirrors `mergeFindingsEffect`, converting offsets first (`convertFindingOffsets` against the current buffer): filter spans exceeding buffer length or empty, replace listed sources, keep selection if the id survives (re-selection-by-equivalence uses the existing `findEquivalent` helper on the tracked shapes).
- After EVERY tracked-state change: `useStore.getState().setTracked(items, selectedId)` AND `outbound.sendFindings(fieldId, markingSpans)`.
- `applySuggestion(id, s)`: look up current span; no span → resolve false. Send `applyReplacement` with fresh `requestId`, `expectedText = buffer.slice(from, to)`; store the pending resolver; **2000 ms timeout resolves false**. `replaceResult(ok, text)`: resolve pending with `ok`; treat `text` as a `textChanged` (host text is truth) — on `ok`, the edit self-invalidates the finding exactly as in the editor.
- `applyRewrite(id, original, replacement)`: locate `original` in the buffer by the same overlap-scan as `rewriteChange` (`findings.ts:121-143`, reuse its loop shape verbatim); not found → resolve false (sidebar shows "sentence changed"); found → same replacement round-trip.
- `selectFinding(id)`: update selection, `setTracked`, `sendSelectFinding`.
- `textChanged` also calls `outbound.onInput()` (debounce hook) and updates `setDocChars`/`setDocWords` via the existing `scoring/score.ts` helpers, and `markScorecardStale()` — mirroring `Editor.tsx:36-44` minus autosave (`noteChange` is document-manager-only and MUST NOT be called).
- `fieldConnected` resets: clears tracked findings (store + host gets empty `findings`), sets buffer, `cancelCheck()` is NOT called here — the embed app does that (Task 6) to keep the shim free of controller imports.

- [ ] **Step 1: Write failing tests.** Cover at minimum:
  - splice derivation: typing in middle/start/end, deletion, paste-replacing-everything, no-op text
  - mapping: finding before / after / overlapping / adjacent to the splice; zero-length drop (port the scenario list from the existing `findings` tests so both implementations share vectors)
  - `mergeFindings`: source replacement, selection persistence, astral conversion end-to-end (server code points → UTF-16 tracked spans)
  - replacement round-trip: ok echo, refused echo, timeout → false, echo text re-syncs buffer
  - rewrite: found-overlapping occurrence replaced; edited sentence → false
  - stale-check integration: after `textChanged`, `getText()` differs from an old snapshot (the controller's guard does the rest — no shim logic needed, but assert `getText()` reflects the newest echo)
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `hostDoc.ts`** per the behavior spec (~200 lines).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Mutation-verify** — break the adjacency-drop condition (`<=` → `<`) and the `expectedText` slice; one named test each must fail; restore.
- [ ] **Step 6: Commit** — `feat(embed): host document shim — splice mapping, replacement round-trip (B43 C1)`

---

### Task 5: Bridge runtime

**Files:**
- Create: `frontend/src/embed/bridge.ts`
- Test: `frontend/src/embed/bridge.test.ts`

**Interfaces:**
- Consumes: `parseHostMessage`, `envelope` (Task 1), `HostDoc` (Task 4), store (`checkPhase`, `tracked`, `authStatus` via `useStore.subscribe`).
- Produces: `startBridge(hostDoc: HostDoc): () => void` (returns teardown), and `hostClientKind(): string` for Task 9. Consumed by Task 6.

**Behavior:**
- `window.addEventListener('message', …)`; before the first valid `hello`: parse, accept ONLY `hello`, then pin `event.source` and `event.origin`; afterwards drop any event whose `source`/`origin` differ from the pinned pair.
- On `hello`: reply `ready` via `(pinnedSource as Window).postMessage(envelope(...), pinnedOrigin)`; record `host.kind` (exposed via `hostClientKind()`, default `'web'`).
- Route `fieldConnected`/`textChanged`/`replaceResult`/`fieldDisconnected`/`markingClicked` to the matching `HostDoc` methods (`markingClicked` → `hostDoc.selectFinding(id)` so a host click selects in the sidebar).
- `status` emission: subscribe to the store; map `checkPhase` (`'fast'|'llm'` → `'checking'`/`'llm-running'`, else `'idle'`), `authStatus !== 'authenticated'` → `'signed-out'`, `llmError` present → `'error'`; include `tracked.length`. Emit only on change.
- All outbound sends no-op until pinned.

- [ ] **Step 1: Write failing tests** — dispatch `MessageEvent`s directly at the handler (export it for tests or use `window.dispatchEvent`): pre-hello non-hello messages ignored; hello pins and answers `ready`; post-hello messages from a different origin ignored; `textChanged` reaches a stub `HostDoc`; teardown removes the listener.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement.** **Step 4: Run, PASS.**
- [ ] **Step 5: Mutation-verify** the origin pinning (accept-all mutation must fail the foreign-origin test); restore.
- [ ] **Step 6: Commit** — `feat(embed): postMessage bridge with origin pinning + status stream (B43 C1)`

---

### Task 6: Embed entry, UI, i18n, Vite multi-page

**Files:**
- Create: `frontend/embed.html` (copy `index.html`, `<div id="root">`, script `/src/embed/main.tsx`, title "Fabulous Writing — Embed")
- Create: `frontend/src/embed/main.tsx`, `frontend/src/embed/EmbedApp.tsx`, `frontend/src/embed/embed.css`
- Create: `frontend/src/header/useHeaderData.ts` (extraction)
- Modify: `frontend/src/App.tsx` (Header uses the extracted hook — code move, comments preserved verbatim)
- Modify: `frontend/vite.config.ts` (multi-page input)
- Modify: `frontend/src/i18n/messages.ts` + all 7 locale files
- Test: `frontend/src/embed/EmbedApp.test.tsx`

**Interfaces:**
- Consumes: Tasks 3-5, existing `LoginGate`, `ProfileSelector`, `DomainMultiSelect`, `LlmSelector`, `LocaleSwitcher`, `AccountMenu`, `Sidebar`, `createCheckScheduler`, `runCheck`, `cancelCheck`.

- [ ] **Step 1: Extract `useHeaderData()`** — move the two effects from `Header` (`App.tsx:94-164`: catalog fetches keyed on `authGeneration`; profile fetch keyed on `language`) into `frontend/src/header/useHeaderData.ts`, comments intact; `Header` calls the hook. Run the full frontend suite (`App.domains-guard.test.tsx` is the net) — green before proceeding. Commit separately: `refactor(frontend): extract useHeaderData from Header (B43 C1)`.
- [ ] **Step 2: Vite config** — add:

```ts
import { resolve } from 'node:path'
// inside defineConfig:
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html'),
      },
    },
  },
```

Note: `simulator.html` (Task 7) is deliberately NOT a build input — dev-server-only.
- [ ] **Step 3: Write failing `EmbedApp.test.tsx`** — with a registered fake port and mocked catalogs: renders the waiting state when no field is connected (`embedWaiting` string); renders selectors + Sidebar + Check button when connected; Check button calls `runCheck(true)`.
- [ ] **Step 4: Implement.**

```tsx
// frontend/src/embed/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import '../App.css'
import './embed.css'
import { LoginGate } from '../auth/LoginGate.tsx'
import { initPrefsPersistence } from '../state/prefsPersistence.ts'
import { setDocumentPort } from '../document/port'
import { createHostDoc } from './hostDoc'
import { startBridge } from './bridge'
import { EmbedApp } from './EmbedApp'
// ... create hostDoc with outbound wired to the bridge sender, register:
//   setDocumentPort(hostDoc); startBridge(hostDoc)
// (construction order: bridge exposes its senders to hostDoc's outbound —
//  createHostDoc takes the outbound object; bridge.ts exports the senders
//  bound lazily so the two can be built in either order)
initPrefsPersistence()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginGate>
      <EmbedApp />
    </LoginGate>
  </StrictMode>,
)
```

`EmbedApp.tsx` composes: a compact header row (`LocaleSwitcher`, `ProfileSelector`, language `<select>` + `DomainMultiSelect` + `LlmSelector` + auto-toggle + Check button — reuse the exact JSX shapes from `Header`, calling `useHeaderData()`), a connection strip (connected field's page URL, or `m.embedWaiting` / `m.embedDisconnected`), then `<Sidebar />`. The scheduler is created in an effect (`fastDelayMs: 1000, llmDelayMs: 5000`, `llmEnabled: () => useStore.getState().llmAuto`) and handed to the hostDoc outbound's `onInput`; `fieldConnected` triggers `cancelCheck()` + an immediate `runCheck(false)`. `embed.css`: single-column layout, sidebar full-width, header controls wrapping.
- [ ] **Step 5: i18n** — add to `Messages` + all locales (informal register; the interface makes a missing locale a compile error):
  - `embedWaiting` — en "Waiting for the host application…", de "Warte auf die Host-Anwendung…", fr "En attente de l'application hôte…", es "Esperando a la aplicación anfitriona…", it "In attesa dell'applicazione ospite…", ja "ホストアプリケーションを待っています…", zh "正在等待宿主应用…"
  - `embedDisconnected` — en "No text field connected.", de "Kein Textfeld verbunden.", fr "Aucun champ de texte connecté.", es "Ningún campo de texto conectado.", it "Nessun campo di testo collegato.", ja "接続されているテキスト欄はありません。", zh "未连接文本框。"
  - `embedReplaceFailed` — en "The host application couldn't apply the change — the text may have changed.", de "Die Host-Anwendung konnte die Änderung nicht übernehmen — der Text hat sich vielleicht geändert.", fr "L'application hôte n'a pas pu appliquer la modification — le texte a peut-être changé.", es "La aplicación anfitriona no pudo aplicar el cambio; puede que el texto haya cambiado.", it "L'applicazione ospite non ha potuto applicare la modifica — forse il testo è cambiato.", ja "ホストアプリケーションが変更を適用できませんでした。テキストが変わった可能性があります。", zh "宿主应用无法应用此更改——文本可能已更改。"
  (`embedReplaceFailed` surfaces via the Sidebar's existing rewrite-failure slot when `applySuggestion`/`applyRewrite` resolve false in embed context — reuse the failure-path UI, don't build a new toast.)
- [ ] **Step 6: Gates** — `npm run test`, lint, `npm run build`; verify `dist/embed.html` exists and `dist/index.html` unchanged behavior (`npm run build` output lists both entries).
- [ ] **Step 7: Commit** — `feat(embed): /embed entry — login, selectors, sidebar over the host shim (B43 C1)`

---

### Task 7: Host simulator + reference TextareaAdapter

**Files:**
- Create: `frontend/simulator.html`, `frontend/src/simulator/main.ts`, `frontend/src/simulator/textareaAdapter.ts`, `frontend/src/simulator/simulator.css`
- Test: `frontend/src/simulator/textareaAdapter.test.ts`

**Interfaces:**
- Consumes: `FieldAdapter`, protocol types (Task 1).
- Produces: `createTextareaAdapter(el: HTMLTextAreaElement): FieldAdapter` — lifted into the C2 extension later; the simulator page is the e2e harness.

**Behavior:**
- `simulator.html`: a page with one `<textarea>` (pre-filled demo text with a deliberate spelling error), a "Connect" button, and `<iframe id="embed" src="/embed.html">` in a right-hand column. Dev-server only (never a build input; served by `vite dev` from the project root). Same-origin in dev → no CSP obstacle.
- `textareaAdapter.ts`:
  - `capabilities()` → `{ mark: 'overlay', replace: 'reliable' }`
  - `extract()` → `el.value`; `onChange` → `input` listener
  - `applyReplacement(from, to, insert, expectedText)`: `el.value.slice(from, to) !== expectedText` → `{ok: false, text: el.value}`; else `el.setRangeText(insert, from, to, 'end')`, dispatch an `input` event, `{ok: true, text: el.value}`
  - `setMarkings`: mirror-overlay div behind the textarea — same font/padding/size (copied via `getComputedStyle`), text split into spans, `fw-mark-<severity>` classes, scroll synced on the textarea's `scroll` event; `flashFinding` scrolls the mark into view and pulses a CSS class
- `main.ts`: instantiate the adapter, wire the protocol over `iframe.contentWindow.postMessage` (targetOrigin `location.origin`): send `hello` on iframe `load` (retry until `ready` arrives), `fieldConnected` on Connect click, `textChanged` on adapter change, answer `applyReplacement` via the adapter with a `replaceResult`, render `findings` through `setMarkings`, `selectFinding` → `flashFinding`, clicks on marks → `markingClicked`.

- [ ] **Step 1: Write failing adapter tests** (jsdom): extract/onChange; `applyReplacement` happy path mutates value and reports new text; `expectedText` mismatch refuses and leaves value untouched.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement adapter.** **Step 4: Run, PASS.**
- [ ] **Step 5: Mutation-verify** the `expectedText` guard (remove the compare → refusal test fails); restore.
- [ ] **Step 6: Implement page + wiring**; hand-check under `vite dev` on a free port (e.g. `npm run dev -- --port 5199`; NEVER 5173): connect, log in inside the iframe (dev backend), see rule findings + overlay marks, apply a suggestion, watch the textarea change. Capture a screenshot for the PR.
- [ ] **Step 7: Commit** — `feat(embed): host simulator + reference textarea adapter (B43 C1)`

---

### Task 8: Backend — embed serving + frame-ancestors CSP

**Files:**
- Modify: `backend/app/core/config.py` (new `EmbedSettings`, wired into `Settings`)
- Modify: `backend/app/main.py` (catch-all + CSP headers)
- Test: `backend/tests/test_embed_serving.py`

**Interfaces:**
- Produces: `settings.embed.allowed_ancestors: list[str]` (config key `embed.allowed_ancestors`, set later in `deploy/fly/config.yaml` when C2 pins the extension ID).

- [ ] **Step 1: Write failing tests** (fixtures build a fake `dist/` in `tmp_path` with `index.html`, `embed.html`, `assets/`):
  - `GET /embed`, `/embed/`, `/embed/anything`, `/embed.html` → 200, body is embed.html's content
  - default config: those responses carry `Content-Security-Policy: frame-ancestors 'none'`
  - `allowed_ancestors=["chrome-extension://abc", "https://example.com"]` → embed responses carry `frame-ancestors chrome-extension://abc https://example.com`; `index.html` fallback and `/` STILL carry `frame-ancestors 'none'`
  - `/api/nope` still 404 JSON; `/assets/*` unaffected (no CSP header required)
  - `Settings.model_validate({"embed": {"allowed_ancestors": ["not a url"]}})` raises; same for entries with spaces, wildcards, or quotes; `'self'` is accepted
  - a dist WITHOUT `embed.html` still boots and serves the SPA; `/embed` then falls back to `index.html` with `'none'` (forward-compat: old dist + new backend must not 500)
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement config**

```python
class EmbedSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")  # a typo'd key must fail loudly
    # CSP frame-ancestors entries for /embed (spec B43): origins allowed to
    # iframe the embed surface, e.g. "chrome-extension://<extension-id>".
    # Empty (the default) renders 'none' — embedding is off until a
    # deployment opts in. Validated at startup: a malformed entry would
    # silently disable the whole CSP directive in some browsers.
    allowed_ancestors: list[str] = Field(default_factory=list)

    @field_validator("allowed_ancestors")
    @classmethod
    def _validate_entries(cls, entries: list[str]) -> list[str]:
        pattern = re.compile(
            r"^(?:'self'|[a-z][a-z0-9+.\-]*://[A-Za-z0-9.\-]+(?::\d+)?)$"
        )
        for entry in entries:
            if not pattern.match(entry):
                raise ValueError(
                    f"embed.allowed_ancestors entry {entry!r} is not 'self' or"
                    " a scheme://host[:port] origin"
                )
        return entries
```

Add `embed: EmbedSettings = Field(default_factory=EmbedSettings)` to `Settings`.
- [ ] **Step 4: Implement serving** — in `create_app`'s static block:

```python
            ancestors = settings.embed.allowed_ancestors
            embed_csp = "frame-ancestors " + (" ".join(ancestors) if ancestors else "'none'")
            embed_page = dist / "embed.html"

            @app.get("/{full_path:path}", include_in_schema=False)
            def spa(full_path: str) -> FileResponse:
                # /api/* never falls back to HTML: a missing API route must
                # stay a JSON 404, not a 200 page.
                if full_path == "api" or full_path.startswith("api/"):
                    raise HTTPException(status_code=404)
                # The embed surface (spec B43): its own HTML entry, its own
                # frame-ancestors policy. Everything else is the main SPA and
                # must never be frameable.
                if (
                    full_path in ("embed", "embed.html") or full_path.startswith("embed/")
                ) and embed_page.is_file():
                    return FileResponse(
                        embed_page, headers={"Content-Security-Policy": embed_csp}
                    )
                target = spa_files.get(full_path)
                if target is not None and target.suffix != ".html":
                    return FileResponse(target)
                return FileResponse(
                    target or dist / "index.html",
                    headers={"Content-Security-Policy": "frame-ancestors 'none'"},
                )
```

(The `embed_page.is_file()` probe is startup-time state like `spa_files` — hoist it: `embed_available = embed_page.is_file()`.)
- [ ] **Step 5: Run, PASS. Full backend gate, zero warnings.**
- [ ] **Step 6: Mutation-verify** — swap `embed_csp` for the `'none'` constant on the embed branch: the allowlist test must fail; drop the `.html`-suffix guard: the index-CSP test must fail. Restore both.
- [ ] **Step 7: Commit** — `feat(backend): serve /embed with configurable frame-ancestors, main SPA 'none' (B43 C1)`

---

### Task 9: `client` tag on the check API (validated, not yet persisted)

**Files:**
- Modify: `backend/app/api/checks.py` (`CheckRequest`)
- Modify: `frontend/src/api/client.ts` (`CheckRequest` interface)
- Modify: `frontend/src/checking/controller.ts` (send the tag)
- Create: `frontend/src/checking/clientTag.ts`
- Test: `backend/tests/test_checks_client_tag.py` (or extend the existing checks API test module), `frontend/src/checking/clientTag.test.ts`

- [ ] **Step 1: Failing backend test** — POST `/api/checks` with `"client": "browser-extension"` → 202; with `"client": "junk"` → 422; without the field → 202 (default `web`).
- [ ] **Step 2: Implement backend** — in `CheckRequest`:

```python
    # Which surface issued this check (spec B43). Validated and accepted
    # since C1 so early clients are forward-compatible; NOT yet persisted —
    # llm_usage has no client column, and that schema change ships with the
    # next schema-touching story together with the B41 day-first index
    # (#126). Until then the field is deliberately unused.
    client: Literal["web", "embed", "browser-extension", "vscode", "jetbrains", "simulator"] = "web"
```

- [ ] **Step 3: Failing frontend test** — `clientTag()` defaults to `'web'`; after `setClientTag('browser-extension')` it returns that; unknown values fall back to `'web'`.
- [ ] **Step 4: Implement frontend** — `clientTag.ts` (leaf get/set with an allowlist mirroring the backend Literal); `bridge.ts` calls `setClientTag(host.kind)` on `hello` (Task 5's `hostClientKind` folds into this module); `client.ts` adds `client?: string` to its `CheckRequest`; `controller.ts` adds `client: clientTag()` to the `postCheck` body.
- [ ] **Step 5: Both gates green. Commit** — `feat(checks): client tag on check requests, persistence deferred (B43 C1)`

---

### Task 10: Architecture docs

**Files:**
- Modify: `docs/backend-architecture.md` (embed serving + CSP config + client tag, in the serving/config sections)
- Modify: `docs/frontend-architecture.md` (new section: embed surface — document port, shim, bridge, protocol, simulator; update the module map)

- [ ] **Step 1: Write both updates** (follow each doc's existing style: prose + file references, no marketing).
- [ ] **Step 2: Commit** — `docs(architecture): embed surface, document port, bridge protocol (B43 C1)`

---

### Task 11: End-to-end verification round (not CI)

No new files; a scripted verification protocol against the dev stack. Ports: NEVER 5173/8000 — use 5199 (vite) and the already-running dev backend at 8000 is NOT touched; instead run a second backend on 8199 with a `tmp`-derived config (sqlite db under the scratchpad, `environment: dev`, `cors.origins: ["http://localhost:5199"]`, auth mode local with `ephemeral_secret: true` and a seeded admin) — the e2e goal is the embed loop, not supabase.

- [ ] **Step 1:** Start backend on 8199 with that config; start `vite dev --port 5199` with `VITE_API_URL=http://localhost:8199`.
- [ ] **Step 2:** Drive `http://localhost:5199/simulator.html` with Playwright (house headless recipe): Connect → log in inside the iframe (seeded admin) → assert findings rows appear for the demo text's planted errors → assert overlay marks in the textarea mirror → click a finding in the sidebar (textarea mark flashes) → apply a suggestion → assert the textarea value changed and the finding disappeared → type into the textarea → assert a re-check fires (status strip) and stale findings dropped.
- [ ] **Step 3:** Negative probe: edit the textarea mid-flight so `expectedText` mismatches (scripted: mutate value between `applyReplacement` and the echo) → the sidebar shows the failure string, text untouched.
- [ ] **Step 4:** Capture screenshots; kill both servers (only the ones started here).
- [ ] **Step 5:** Commit any fixes found, re-run the relevant unit gates.

---

## Deferred / follow-ups created by this plan

- `client` column on `llm_usage` + activity attribution — with the next schema-touching story, alongside B41 (#126).
- Main-app astral-offset fix (`editor/findings.ts` consumes backend code points unconverted) — pre-existing, now half-fixed (embed path only); backlog issue on merge.
- `deploy/fly/config.yaml` gains `embed.allowed_ancestors` only in C2 (needs the pinned extension ID); `test_fly_config.py` guard lands then.
