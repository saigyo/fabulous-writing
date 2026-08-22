# C1: Embed Surface + Bridge Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve an embeddable login+sidebar UI at `/embed/` with a versioned postMessage bridge, a host-document shim replacing CodeMirror, backend CSP/serving support, and a host-simulator page proving the full check→findings→replace loop.

**Architecture:** A second Vite entry composes existing auth/header/sidebar modules over a new host-document shim; a document-port indirection (a leaf module in the spirit of `checking/cancelSlot.ts`) lets `controller.ts`, `suggest.ts`, `autosave.ts`, and `Sidebar.tsx` run against either CodeMirror or the shim. The backend serves `embed.html` under `/embed*` with a configurable `frame-ancestors` CSP, default-deny.

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
- Protocol offsets are **UTF-16 code units** (spec, normative). Backend spans are Python code points. The embed shim converts in BOTH directions: inbound findings (code points → UTF-16, Task 2/4) and outbound suggestion spans (UTF-16 → code points, Task 2/3/4). The CodeMirror port stays unconverted in both directions (its latent astral bug is out of scope — Deferred).
- New user-facing strings: informal register (Du/tu/tú), added to ALL 7 locales; the `Messages` interface makes omissions a compile error. The three `embed*` strings are status text, not direct address; match each locale's existing status-message tone.
- **Scope ruling (deviation from spec, deliberate):** the `client` tag is added to the API (validated, default `"web"`) but NOT persisted — `llm_usage` has no `client` column and adding one is a schema change, which per house policy ships with the next schema-touching story together with B41's day-first index (#126). Task 9 documents this in code; the spec amendment lands in Task 10.
- **Config deviation from spec (deliberate):** the spec names an env var `FW_EMBED_ALLOWED_ANCESTORS`, but `load_settings()` (config.py:573-586) reads YAML only — there is no per-key env overlay in `Settings`. The setting is the YAML key `embed.allowed_ancestors`. Task 10 amends the spec.

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

const caps = { mark: 'overlay', replace: 'reliable' }

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

  it('rejects fieldConnected with missing or malformed capabilities', () => {
    const base = { fw: PROTOCOL_VERSION, type: 'fieldConnected' }
    expect(
      parseHostMessage({ ...base, payload: { fieldId: 'f1', text: 't', meta: { url: '', fieldKind: '' } } }),
    ).toBeNull()
    expect(
      parseHostMessage({
        ...base,
        payload: { fieldId: 'f1', text: 't', capabilities: { mark: 'sparkly', replace: 'reliable' }, meta: { url: '', fieldKind: '' } },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        ...base,
        payload: { fieldId: 'f1', text: 't', capabilities: caps, meta: { url: '', fieldKind: '' } },
      }),
    ).not.toBeNull()
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

export const MARK_CAPABILITIES = ['overlay', 'native', 'none'] as const
export const REPLACE_CAPABILITIES = ['reliable', 'best-effort', 'none'] as const
export type MarkCapability = (typeof MARK_CAPABILITIES)[number]
export type ReplaceCapability = (typeof REPLACE_CAPABILITIES)[number]

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

function validCapabilities(value: unknown): value is HostCapabilities {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    MARK_CAPABILITIES.includes(c.mark as MarkCapability) &&
    REPLACE_CAPABILITIES.includes(c.replace as ReplaceCapability)
  )
}

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
      if (!validCapabilities(pay.capabilities)) return null
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
// Deviation from the spec's protocol table, recorded in Task 10: capabilities
// travel on fieldConnected (per field), not on hello — matching the spec's
// own prose ("per-field capabilities").
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
- [ ] **Step 5: Mutation-verify** — drop the `validCapabilities` call; the fieldConnected test must fail; restore.
- [ ] **Step 6: Commit** — `feat(embed): bridge protocol module + FieldAdapter contract (B43 C1)`

---

### Task 2: Offset conversion, both directions

**Files:**
- Create: `frontend/src/embed/offsets.ts`
- Test: `frontend/src/embed/offsets.test.ts`

**Interfaces:**
- Produces (consumed by Task 4):
  - `convertFindingOffsets(text: string, findings: Finding[]): Finding[]` — spans in code points (backend) → UTF-16 units against the same `text`.
  - `toCodePointSpan(text: string, from: number, to: number): { start: number; end: number }` — UTF-16 units → code points (for outbound `/api/suggestions` spans).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/embed/offsets.test.ts
import { describe, expect, it } from 'vitest'
import type { Finding } from '../types'
import { convertFindingOffsets, toCodePointSpan } from './offsets'

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

describe('toCodePointSpan', () => {
  it('is identity for BMP-only text', () => {
    expect(toCodePointSpan('hello', 1, 3)).toEqual({ start: 1, end: 3 })
  })

  it('inverts convertFindingOffsets across astral text', () => {
    const text = '𝔸 bad'
    // UTF-16 [3,6) is 'bad'; code points [2,5)
    expect(toCodePointSpan(text, 3, 6)).toEqual({ start: 2, end: 5 })
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**

```ts
// frontend/src/embed/offsets.ts
import type { Finding } from '../types'

// Backend spans are code-point offsets (Python); the bridge protocol and the
// shim work in UTF-16 units (spec B43). Both directions are needed: findings
// come IN as code points, suggestion-request spans go OUT as code points.

function codePointToUtf16Map(text: string): number[] | null {
  // Fast path: no astral characters -> code points == UTF-16 units.
  if (!/[\uD800-\uDBFF]/.test(text)) return null
  const map: number[] = []
  let utf16 = 0
  for (const cp of text) {
    map.push(utf16)
    utf16 += cp.length
  }
  map.push(utf16) // end-of-text sentinel: span.end may equal text length
  return map
}

/**
 * Convert backend findings to UTF-16 spans against the checked-text
 * snapshot. Findings whose converted slice does not equal span.text are
 * dropped — the "spans are exact" invariant must hold after conversion too.
 */
export function convertFindingOffsets(text: string, findings: Finding[]): Finding[] {
  const map = codePointToUtf16Map(text)
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

/** UTF-16 [from,to) in `text` -> the same range in code points. */
export function toCodePointSpan(
  text: string, from: number, to: number,
): { start: number; end: number } {
  if (!/[\uD800-\uDBFF]/.test(text)) return { start: from, end: to }
  // Counting code points in the prefixes is O(n) and runs only on the
  // suggestion-request path — no cache needed.
  const start = [...text.slice(0, from)].length
  const end = start + [...text.slice(from, to)].length
  return { start, end }
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(embed): two-way code-point/UTF-16 offset conversion (B43 C1)`

---

### Task 3: Document port indirection (refactor, no behavior change)

**Files:**
- Create: `frontend/src/checking/documentPort.ts` (NOT `src/document/` — a sibling of the existing `src/documents/` package would invite permanent misreading)
- Create: `frontend/src/editor/editorPort.ts`
- Modify: `frontend/src/checking/controller.ts` (all `getEditorView()`/dispatch sites)
- Modify: `frontend/src/checking/suggest.ts` (text + tracked-item + span reads)
- Modify: `frontend/src/documents/autosave.ts` (its `getEditorView()` text read — this module IS in the embed graph via `controller.ts`/`suggest.ts` imports, and its `editorRef` import would drag `@codemirror/*` into the embed bundle)
- Modify: `frontend/src/documents/hydration.ts` (same reason, deeper chain: `LoginGate → auth/session.ts → documents/documents.ts → hydration.ts` value-imports `getEditorView` + `setFindingsEffect` — without this the embed bundle can NEVER be CodeMirror-free; its editor writes go through the new `port.setDocument`)
- Modify: `frontend/src/sidebar/Sidebar.tsx` (3 imports from `editorRef` → the port; note `apply()`/`applyHeldBack()` in `RewriteArea` become `async` because `applyRewrite` now returns a Promise — no existing test exercises those paths, but say so in the commit message)
- Modify: `frontend/src/main.tsx` (side-effect import `./editor/editorPort` — NOT in `Editor.tsx`: component tests `vi.mock` the Editor module wholesale, which would silently skip registration)
- Modify: `frontend/src/checking/controller.test.ts`, `frontend/src/checking/suggest.test.ts`, AND the three suites that currently feed `collectSnapshot` through `vi.mock('../editor/editorRef')` and would go inert once autosave reads the port — `frontend/src/documents/autosave.test.ts:22-24`, `frontend/src/documents/documents.test.ts:45-47`, `frontend/src/auth/session.integration.test.ts:25-27` (all five register a fake port instead of faking an EditorView/editorRef)
- Test: existing suites are the net; add `frontend/src/checking/documentPort.test.ts` for registration semantics

**Interfaces:**
- Produces (consumed by Tasks 4, 5, 6):

```ts
// frontend/src/checking/documentPort.ts
// Leaf module in the spirit of checking/cancelSlot.ts: the checking layer
// and the sidebar talk to "the document" through this port; the main app
// registers a CodeMirror implementation (editor/editorPort.ts) from
// main.tsx, the embed registers the host-document shim. No module imports
// both sides. Like cancelSlot, the default is a null object, not null —
// call sites never null-check, and "no port" behaves as an empty document.
import type { TrackedFinding } from '../editor/findings' // type-only: erases
import type { Finding, Source } from '../types'

export type ApplyResult = 'ok' | 'not-found' | 'refused'

export interface DocumentPort {
  /** False when no real document is behind the port (no EditorView / no
   * connected field / null object). Guards that previously read "is there
   * a view?" MUST use this — getText() === '' is NOT a substitute: an
   * empty string is also a legitimate empty document, and autosave PUTting
   * '' over a real document would be data loss. */
  hasDocument(): boolean
  getText(): string
  /** Replace the whole document and its findings (document-manager
   * hydration path). No-op in the embed shim — the document manager never
   * runs there. */
  setDocument(text: string, findings: Finding[]): void
  /** The finding's current tracked state (live document state, not the
   * store's post-hoc mirror), or null if it was dropped. */
  currentFinding(id: string): TrackedFinding | null
  /** The finding's span in BACKEND offsets (code points) for outbound
   * requests. Identity with the tracked span in the CodeMirror port. */
  serverSpan(id: string): { start: number; end: number } | null
  /** Replace all findings of the given sources (no staleness check — the
   * caller compares getText() against its checked snapshot first). */
  mergeFindings(replaceSources: Source[], findings: Finding[]): void
  selectFinding(id: string | null): void
  /** 'ok' = applied; 'not-found' = the finding/sentence is gone (stale);
   * 'refused' = the host declined or timed out (embed only). */
  applySuggestion(id: string, suggestion: string): Promise<ApplyResult>
  applyRewrite(id: string, original: string, replacement: string): Promise<ApplyResult>
}

const nullPort: DocumentPort = {
  hasDocument: () => false,
  getText: () => '',
  setDocument: () => {},
  currentFinding: () => null,
  serverSpan: () => null,
  mergeFindings: () => {},
  selectFinding: () => {},
  applySuggestion: () => Promise.resolve('not-found'),
  applyRewrite: () => Promise.resolve('not-found'),
}

let port: DocumentPort = nullPort
export function setDocumentPort(p: DocumentPort | null): void { port = p ?? nullPort }
export function getDocumentPort(): DocumentPort { return port }
```

- [ ] **Step 1: Write `documentPort.test.ts`** — default port returns `false`/`''`/`null`/`'not-found'` and no-ops (`hasDocument()` false is the load-bearing one — autosave's data-loss guard); the registered instance is returned after `setDocumentPort(fake)`; `setDocumentPort(null)` restores the null object. Run: FAIL (module missing).
- [ ] **Step 2: Create `checking/documentPort.ts`** exactly as above; test PASSES.
- [ ] **Step 3: Create `editor/editorPort.ts`** — the CodeMirror implementation, registered at module load:

```ts
// frontend/src/editor/editorPort.ts
import type { DocumentPort } from '../checking/documentPort'
import { setDocumentPort } from '../checking/documentPort'
import { applyRewrite, applySuggestion, getEditorView, selectFinding } from './editorRef'
import { findingsField, mergeFindingsEffect, setFindingsEffect } from './findings'

function item(id: string) {
  const view = getEditorView()
  return view?.state.field(findingsField).items.find((it) => it.finding.id === id) ?? null
}

const cmPort: DocumentPort = {
  hasDocument: () => getEditorView() !== null,
  getText: () => getEditorView()?.state.doc.toString() ?? '',
  setDocument(text, findings) {
    // The hydration path's editor writes, moved behind the port: replace
    // the whole doc and set the findings in one place. Implementer lifts
    // the exact dispatch sequence from documents/hydration.ts (doc
    // replacement + setFindingsEffect) — semantics unchanged.
    const view = getEditorView()
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: setFindingsEffect.of(findings),
    })
  },
  currentFinding: item,
  // Unconverted, matching the app's existing (latently astral-buggy)
  // behavior — the fix is tracked, out of scope here.
  serverSpan(id) {
    const it = item(id)
    return it ? { start: it.from, end: it.to } : null
  },
  mergeFindings(replaceSources, findings) {
    getEditorView()?.dispatch({
      effects: mergeFindingsEffect.of({ replaceSources, findings }),
    })
  },
  selectFinding,
  applySuggestion(id, suggestion) {
    if (!item(id)) return Promise.resolve('not-found')
    applySuggestion(id, suggestion)
    return Promise.resolve('ok')
  },
  applyRewrite: (id, original, replacement) =>
    Promise.resolve(applyRewrite(id, original, replacement) ? 'ok' : 'not-found'),
}
setDocumentPort(cmPort)
```

- [ ] **Step 4: Rewire consumers.** Mechanical mapping, preserving every guard comment:
  - `controller.ts`: drop the `getEditorView`/`mergeFindingsEffect` imports; `const view = getEditorView(); if (!view) return` → `const port = getDocumentPort()` (no null check — null object); `view.state.doc.toString()` → `port.getText()`; the empty-text branch's dispatch → `port.mergeFindings(['rule', 'terminology', 'llm'], [])`; `applyFindings()` keeps its snapshot compare (`port.getText() !== checkedText → return`) then `port.mergeFindings(sources, findings)`; **`onScorecard`**: the current guard is `if (view && view.state.doc.toString() !== text)` — with the null port `getText()` is `''`, which `!== text` for any non-empty check, so the rewrite must keep an explicit connected-document notion. Use `if (port.getText() !== text)` ONLY after confirming the runCheck early-return already filtered the empty-document case (it does: `!text.trim()` returns before any subscription) — a null-port scorecard arriving mid-teardown marks stale, which is harmless and matches "document gone".
  - `suggest.ts`: text via `port.getText()`; the tracked item via `port.currentFinding(id)` (it needs `item.finding.message` and `item.finding.rule_id`, not just the span — see its own test fake); the REQUEST span via `port.serverSpan(id)` (code points outbound).
  - `autosave.ts`: `collectSnapshot()` becomes `if (!getDocumentPort().hasDocument() || !state.docMeta || !state.user) return null` — the `hasDocument()` check REPLACES the current `!view` check one-for-one. Dropping it would let the null-object port produce a snapshot with `text: ''` that `flush()` (beforeunload, document switch, post-check) PUTs over a real document — a data-loss shape, which is exactly why the port has `hasDocument()`. Then read text via `getDocumentPort().getText()`; delete the `editorRef` import.
  - `hydration.ts`: its editor writes (doc replacement + `setFindingsEffect` dispatch) become `getDocumentPort().setDocument(text, findings)`; any view-existence guard becomes `hasDocument()`; delete the `editorRef`/`findings` imports. This is what actually severs the `LoginGate → session → documents → hydration → editorRef → @codemirror/*` chain from the embed bundle.
  - `Sidebar.tsx`: `import { getDocumentPort } from '../checking/documentPort'`; call sites `void getDocumentPort().applySuggestion(...)` etc. — the RESULT handling changes land in Task 6 (this task is behavior-neutral; `applyRewrite`'s existing false-branch maps to `result !== 'ok'` for now).
  - `main.tsx`: add `import './editor/editorPort'`.
- [ ] **Step 5: Adapt `controller.test.ts` / `suggest.test.ts`** — replace EditorView fakes with `setDocumentPort(fakePort)` in setup and `setDocumentPort(null)` in teardown. The fake records `mergeFindings` calls and serves `hasDocument` (true), `getText`, `currentFinding`, `serverSpan`. In the three document/session suites the fake's `getText` must return the same text their old `editorRef` mocks returned, and its `hasDocument` must be true — otherwise `collectSnapshot` yields null and every content assertion drifts.
- [ ] **Step 6: Full frontend gate** — `npm run test`, `rtk proxy npm run lint`, `npm run build`. Everything green: this task changes NO behavior.
- [ ] **Step 7: Mutation check** — temporarily remove the snapshot compare in `applyFindings`; the existing stale-findings controller test must fail; restore.
- [ ] **Step 8: Commit** — `refactor(frontend): document-port indirection for checking, autosave + sidebar (B43 C1)`

---

### Task 4: Host document shim

**Files:**
- Create: `frontend/src/embed/hostDoc.ts`
- Test: `frontend/src/embed/hostDoc.test.ts`

**Interfaces:**
- Consumes: `DocumentPort`/`ApplyResult` (Task 3), `convertFindingOffsets`/`toCodePointSpan` (Task 2), `MarkingSpan`/`HostCapabilities` (Task 1), store `setTracked` (existing).
- Produces (consumed by Tasks 5, 6):

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

Note: there is NO separate merge method — the shim's `DocumentPort.mergeFindings`
implementation itself converts incoming spans via `convertFindingOffsets(buffer, findings)`
before tracking (the controller's snapshot guard guarantees the buffer equals the checked
text at that moment). `serverSpan` converts outbound via `toCodePointSpan(buffer, from, to)`.
Port members from Task 3's extension: `hasDocument()` delegates to `connected()`;
`setDocument()` is a documented no-op (the document manager never runs in the embed).

**Behavior spec (port of `editor/findings.ts` semantics to a single-splice world):**

- `textChanged` derives the splice as an algorithm, no post-hoc correction:
  `p` = longest common prefix length; then scan backwards for the longest
  common suffix `s` with the explicit bound `s <= min(oldLen, newLen) - p`
  (INCLUSIVE — the strict form is off by one: a pure insertion/deletion has
  `p + s == min(oldLen, newLen)` exactly, and clamping `s` one short widens
  the splice by one character, wrongly dropping an adjacent finding that
  CodeMirror's insertion mapping keeps).
  Old range `[p, oldLen - s)` replaced by `new.slice(p, newLen - s)`.
- Tracked findings map through the splice:
  - `item.to < spliceFrom` → unchanged; `item.from > spliceTo` → shift by `insertLen - (spliceTo - spliceFrom)`.
  - Any overlap **or adjacency** with the replaced range (`item.from <= spliceTo && spliceFrom <= item.to`) when the splice is a real change → drop (same predicate `touchesRange` uses, including the insertion-at-boundary drop).
  - Zero-length results drop.
  - Parity claim, precise form: identical to CodeMirror for every splice the
    diff recovers. The diff recovers the RIGHTMOST of several equivalent
    edits, so a finding inside a duplicated region may survive an edit
    CodeMirror would drop — the span text still matches by construction.
    One such case is a documented-expected-divergence test, not a bug.
- `mergeFindings` mirrors `mergeFindingsEffect`, converting offsets first (`convertFindingOffsets` against the current buffer): filter spans exceeding buffer length or empty, replace listed sources, keep selection if the id survives (re-selection-by-equivalence uses the existing `findEquivalent` helper on the tracked shapes).
- After EVERY tracked-state change: `useStore.getState().setTracked(items, selectedId)` AND `outbound.sendFindings(fieldId, markingSpans)`.
- `applySuggestion(id, s)`: `currentFinding(id)` null → resolve `'not-found'`. Send `applyReplacement` with fresh `requestId`, `expectedText = buffer.slice(from, to)`; store the pending resolver; **2000 ms timeout resolves `'refused'`**. `replaceResult(ok, text)`: resolve pending with `ok ? 'ok' : 'refused'`; treat `text` as a `textChanged` (host text is truth) — on ok, the edit self-invalidates the finding exactly as in the editor.
- `applyRewrite(id, original, replacement)`: locate `original` in the buffer by the same overlap-scan as `rewriteChange` (`findings.ts:121-143`, reuse its loop shape verbatim); not found → resolve `'not-found'`; found → same replacement round-trip (`'ok'`/`'refused'`).
- `selectFinding(id)`: update selection, `setTracked`, `sendSelectFinding`.
- `textChanged` also calls `outbound.onInput()` (debounce hook) and updates `setDocChars`/`setDocWords` via the existing `scoring/score.ts` helpers, and `markScorecardStale()` — mirroring `Editor.tsx:36-44` minus autosave (`noteChange` is document-manager-only and MUST NOT be called).
- `fieldConnected` resets: clears tracked findings (store + host gets empty `findings`), sets buffer. `cancelCheck()` is NOT called here — the embed app does that (Task 6) to keep the shim free of controller imports.

- [ ] **Step 1: Write failing tests.** Cover at minimum:
  - splice derivation: typing in middle/start/end, deletion, paste-replacing-everything, no-op text, and the degenerate vectors `"aa" → "a"`, `"a" → "aa"`, `"" → "x"`, `"x" → ""`; PLUS the suffix-bound guard vector: `"the cat" → "theX cat"` with a finding on `"cat"` `[4,7)` — the splice must be a pure insertion at 3 and the finding must SURVIVE shifted to `[5,8)` (an off-by-one suffix bound widens the splice and wrongly drops it; this is the mutation-verification target for the bound)
  - mapping: finding before / after / overlapping / adjacent to the splice; zero-length drop (port the scenario list from the existing `findings` tests so both implementations share vectors); the rightmost-splice divergence case as a documented expectation
  - `mergeFindings`: source replacement, selection persistence, astral conversion end-to-end (server code points → UTF-16 tracked spans)
  - `serverSpan`: astral round-trip — the code-point span it returns slices the same substring in a Python-semantics sense (compare against `[...buffer]` slicing)
  - replacement round-trip: ok echo → `'ok'`; refused echo → `'refused'`; timeout → `'refused'`; echo text re-syncs buffer
  - rewrite: found-overlapping occurrence replaced; edited sentence → `'not-found'`
  - `getText()` reflects the newest echo after a replacement
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `hostDoc.ts`** per the behavior spec (~220 lines).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Mutation-verify** — break the adjacency-drop condition (`<=` → `<`) and the `expectedText` slice; one named test each must fail; restore.
- [ ] **Step 6: Commit** — `feat(embed): host document shim — splice mapping, replacement round-trip (B43 C1)`

---

### Task 5: Bridge runtime

**Files:**
- Create: `frontend/src/embed/bridge.ts`
- Test: `frontend/src/embed/bridge.test.ts`

**Interfaces:**
- Consumes: `parseHostMessage`, `envelope` (Task 1), `HostDoc`/`HostDocOutbound` (Task 4 — type-only for `HostDoc`), store (`checkPhase`, `tracked`, `authStatus`, `llmError` via `useStore.subscribe`), `setClientTag` (Task 9; until Task 9 lands, keep a local no-op TODO-free stub by simply not calling it — the bridge records `host.kind` internally either way).
- Produces (consumed by Task 6):

```ts
export interface Bridge {
  /** Outbound sender set — hand to createHostDoc(). No-ops until pinned. */
  outbound: HostDocOutbound
  /** Wire the message routing to a HostDoc and start listening. */
  attach(hostDoc: HostDoc): void
  dispose(): void
  hostKind(): string // 'web' until a hello arrives
}
export function startBridge(): Bridge
```

This breaks the Task 4 ↔ Task 5 construction cycle: `main.tsx` (Task 6) reads
`const bridge = startBridge(); const doc = createHostDoc(bridge.outbound); bridge.attach(doc); setDocumentPort(doc)`.
Task 4's tests use a plain stub outbound; Task 5's tests use a stub HostDoc.

**Behavior:**
- `window.addEventListener('message', …)` (registered in `attach`); before the first valid `hello`: parse, accept ONLY `hello`, then pin `event.source` and `event.origin`; afterwards drop any event whose `source`/`origin` differ from the pinned pair.
- On `hello`: reply `ready` via `(pinnedSource as Window).postMessage(envelope(...), pinnedOrigin)`; record `host.kind`.
- Route `fieldConnected`/`textChanged`/`replaceResult`/`fieldDisconnected` to the matching `HostDoc` methods; `markingClicked` → `hostDoc.selectFinding(id)` so a host click selects in the sidebar.
- `status` emission: subscribe to the store; map `checkPhase` (`'fast'` → `'checking'`, `'llm'` → `'llm-running'`, else `'idle'`), `authStatus !== 'authenticated'` → `'signed-out'` (wins), `llmError` present → `'error'`; include `tracked.length`. Emit only on change.
- All outbound sends no-op until pinned.

- [ ] **Step 1: Write failing tests** — dispatch `MessageEvent`s via `window.dispatchEvent`: pre-hello non-hello messages ignored; hello pins and answers `ready`; post-hello messages from a different origin ignored; `textChanged` reaches the stub `HostDoc`; `dispose` removes the listener.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement.** **Step 4: Run, PASS.**
- [ ] **Step 5: Mutation-verify** the origin pinning (accept-all mutation must fail the foreign-origin test); restore.
- [ ] **Step 6: Commit** — `feat(embed): postMessage bridge with origin pinning + status stream (B43 C1)`

---

### Task 6: Embed entry, UI, i18n, Vite multi-page

**Files:**
- Create: `frontend/embed.html` (copy `index.html`, `<div id="root">`, script `/src/embed/main.tsx`, title "Fabulous Writing — Embed")
- Create: `frontend/src/embed/main.tsx`, `frontend/src/embed/EmbedApp.tsx`, `frontend/src/embed/embed.css`
- Create: `frontend/src/i18n/LocaleSwitcher.tsx` (extraction — it is currently a module-LOCAL function in `App.tsx:274`; importing `App.tsx` from the embed would pull the entire app graph)
- Create: `frontend/src/header/useHeaderData.ts` (extraction)
- Modify: `frontend/src/App.tsx` (imports `LocaleSwitcher`, `Header` uses the extracted hook — code moves, comments preserved verbatim)
- Modify: `frontend/src/sidebar/Sidebar.tsx` (surface `ApplyResult` failures — see Step 5)
- Modify: `frontend/vite.config.ts` (multi-page input)
- Modify: `frontend/src/i18n/messages.ts` + all 7 locale files
- Test: `frontend/src/embed/EmbedApp.test.tsx`

**Interfaces:**
- Consumes: Tasks 3-5, existing `LoginGate`, `ProfileSelector`, `DomainMultiSelect`, `LlmSelector`, `AccountMenu`, `Sidebar`, `createCheckScheduler`, `runCheck`, `cancelCheck`.

- [ ] **Step 1: Extractions (one commit, before the embed entry).**
  - Move `LocaleSwitcher` from `App.tsx` to `frontend/src/i18n/LocaleSwitcher.tsx` (export it); `App.tsx` imports it.
  - Move the two `Header` effects (`App.tsx:94-164`) into `frontend/src/header/useHeaderData.ts` — INCLUDING the `prevLanguage` ref between them (`App.tsx:127`), which belongs to the second effect and keeps it StrictMode-correct; comments intact; `Header` calls the hook.
  - Run the full frontend suite (`App.domains-guard.test.tsx` is the net — its `vi.mock('./api/client', …)` still applies to the hook, Vitest mocks by resolved module id) — green before proceeding.
  - Commit: `refactor(frontend): extract LocaleSwitcher + useHeaderData from App (B43 C1)`.
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
import { setDocumentPort } from '../checking/documentPort'
import { createHostDoc } from './hostDoc'
import { startBridge } from './bridge'
import { EmbedApp } from './EmbedApp'

const bridge = startBridge()
const hostDoc = createHostDoc(bridge.outbound)
bridge.attach(hostDoc)
setDocumentPort(hostDoc)
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
- [ ] **Step 5: Surface replacement failures in the Sidebar** (this is where `ApplyResult` becomes user-visible; without it a refused/timed-out replacement is silently swallowed and `embedReplaceFailed` would be a dead string):
  - `SuggestionArea` (and the equivalent apply sites at `Sidebar.tsx:279-282, 322`): `const result = await getDocumentPort().applySuggestion(...)`; on `'refused'` → `store.setSuggestError(finding.id, m.embedReplaceFailed)`; `'not-found'` stays silent (matches today's behavior). **Render-site caveat:** the existing `suggest-error` `<p>` (`Sidebar.tsx:314-318`) sits in `SuggestionArea`'s no-suggestions return and is UNREACHABLE while `suggestions.length > 0` — which is exactly when the apply buttons exist. Add the same `<p className="suggest-error">{error}</p>` element to the has-suggestions branch (`Sidebar.tsx:271-288` return), keeping the cached suggestions on screen (do NOT clear them the way `RewriteArea` clears its rewrite — losing fetched suggestions on a host refusal would force a re-fetch).
  - `RewriteArea`: `'not-found'` keeps the existing `m.sentenceChangedRewriteAgain`; `'refused'` sets `m.embedReplaceFailed` instead. The discriminated `ApplyResult` (Task 3) is exactly what makes these two distinguishable.
  - Component test: a fake port resolving `'refused'` renders the failure string; resolving `'not-found'` on rewrite renders the sentence-changed string.
- [ ] **Step 6: i18n** — add to `Messages` + all locales (informal register; the interface makes a missing locale a compile error):
  - `embedWaiting` — en "Waiting for the host application…", de "Warte auf die Host-Anwendung…", fr "En attente de l'application hôte…", es "Esperando a la aplicación anfitriona…", it "In attesa dell'applicazione ospite…", ja "ホストアプリケーションを待っています…", zh "正在等待宿主应用…"
  - `embedDisconnected` — en "No text field connected.", de "Kein Textfeld verbunden.", fr "Aucun champ de texte connecté.", es "Ningún campo de texto conectado.", it "Nessun campo di testo collegato.", ja "接続されているテキスト欄はありません。", zh "未连接文本框。"
  - `embedReplaceFailed` — en "The host application couldn't apply the change — the text may have changed.", de "Die Host-Anwendung konnte die Änderung nicht übernehmen — der Text hat sich vielleicht geändert.", fr "L'application hôte n'a pas pu appliquer la modification — le texte a peut-être changé.", es "La aplicación anfitriona no pudo aplicar el cambio; puede que el texto haya cambiado.", it "L'applicazione ospite non ha potuto applicare la modifica — forse il testo è cambiato.", ja "ホストアプリケーションが変更を適用できませんでした。テキストが変わった可能性があります。", zh "宿主应用无法应用此更改——文本可能已更改。"
- [ ] **Step 7: Gates + bundle guard** — `npm run test`, lint, `npm run build`; verify `dist/embed.html` exists. Then the CodeMirror-free assertion (this is the spec's tree-shaking claim, and it MUST be checked, or Task 3's autosave fix can silently regress): enable `build.manifest: true` (or read the rollup output), walk the chunk graph reachable from the `embed` entry, and assert no chunk sources `@codemirror/`. Add it as a small node script `frontend/scripts/check-embed-bundle.mjs` invoked in the build step of CI later (C2); for C1 run it manually and paste the result into the PR.
- [ ] **Step 8: Commit** — `feat(embed): /embed entry — login, selectors, sidebar over the host shim (B43 C1)`

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
- **Desync hook for the e2e negative probe** (without it the `expectedText` mismatch is unreachable from the UI — the simulator's echo loop is synchronous): with `simulator.html?desync=1`, `main.ts` suppresses the next `textChanged` after a keystroke and mutates the textarea (prepend one character) upon receiving the next `applyReplacement`, before handing it to the adapter — guaranteeing the mismatch branch and a `replaceResult ok:false`.

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
- Modify: `backend/config.example.yaml` (commented `embed:` block — the documented surface for every other settings block)
- Test: extend `backend/tests/test_container_serving.py` (it already has the `make_dist(tmp_path)` / `make_app(tmp_path, dist)` fixtures with a safe `db_path` — REUSE them: add an `embed: bool = True` parameter to `make_dist`, an `ancestors: list[str] | None = None` parameter to `make_app` (merged into the `Settings` it builds — it has no override hook today), add a `TestEmbedServing` class, and add the `frame-ancestors 'none'` assertions to the existing `TestSpaServing` cases). Config-validator tests go in the config test module next to the other `Settings` validators.

**Interfaces:**
- Produces: `settings.embed.allowed_ancestors: list[str]` (YAML key `embed.allowed_ancestors`; set later in `deploy/fly/config.yaml` when C2 pins the extension ID — the `test_fly_config.py` guard lands then).

- [ ] **Step 1: Write failing tests:**
  - `GET /embed`, `/embed/`, `/embed/anything`, `/embed.html` → 200, body is embed.html's content
  - default config: those responses carry `Content-Security-Policy: frame-ancestors 'none'`
  - `allowed_ancestors=["chrome-extension://abc", "https://example.com"]` → embed responses carry `frame-ancestors chrome-extension://abc https://example.com`; `index.html` fallback and `/` STILL carry `frame-ancestors 'none'`
  - `/api/nope` still 404 JSON; `/assets/*` unaffected (no CSP header required); non-HTML exact files carry no CSP header
  - `Settings.model_validate({"embed": {"allowed_ancestors": ["not a url"]}})` raises; same for entries with spaces, wildcards, or quotes-in-the-middle; `'self'` is accepted
  - a dist WITHOUT `embed.html` still boots and serves the SPA; `/embed` then falls back to `index.html` with `'none'` (forward-compat: old dist + new backend must not 500) — `make_dist(embed=False)`
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement config** (style matches `ProviderCreditSettings`/`DatabaseSettings`: `field_validator` + `@classmethod` + `extra="forbid"`):

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

Add `embed: EmbedSettings = Field(default_factory=EmbedSettings)` to `Settings`, and the commented block to `config.example.yaml`.
- [ ] **Step 4: Implement serving** — in `create_app`'s static block:

```python
            ancestors = settings.embed.allowed_ancestors
            embed_csp = "frame-ancestors " + (" ".join(ancestors) if ancestors else "'none'")
            embed_page = dist / "embed.html"
            embed_available = embed_page.is_file()

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
                ) and embed_available:
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

- [ ] **Step 5: Run, PASS. Full backend gate, zero warnings.**
- [ ] **Step 6: Mutation-verify** — swap `embed_csp` for the `'none'` constant on the embed branch: the allowlist test must fail; drop the `.html`-suffix guard: the index-CSP test must fail. Restore both.
- [ ] **Step 7: Commit** — `feat(backend): serve /embed with configurable frame-ancestors, main SPA 'none' (B43 C1)`

---

### Task 9: `client` tag on the check API (validated, not yet persisted)

**Files:**
- Modify: `backend/app/api/checks.py` (`CheckRequest`)
- Modify: `frontend/src/api/client.ts` (`CheckRequest` interface)
- Modify: `frontend/src/checking/controller.ts` (send the tag)
- Modify: `frontend/src/embed/bridge.ts` (call `setClientTag(hostKind)` on hello)
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
- [ ] **Step 4: Implement frontend** — `clientTag.ts` (leaf get/set with an allowlist mirroring the backend Literal); `bridge.ts` calls `setClientTag(host.kind)` on `hello`; `client.ts` adds `client?: string` to its `CheckRequest`; `controller.ts` adds `client: clientTag()` to the `postCheck` body.
- [ ] **Step 5: Both gates green. Commit** — `feat(checks): client tag on check requests, persistence deferred (B43 C1)`

---

### Task 10: Docs — architecture + spec amendments

**Files:**
- Modify: `docs/backend-architecture.md` (embed serving + CSP config + client tag, in the serving/config sections)
- Modify: `docs/frontend-architecture.md` (new section: embed surface — document port, shim, bridge, protocol, simulator; update the module map)
- Modify: `docs/superpowers/specs/2026-08-22-b43-embeddable-clients-design.md` — three amendment notes, each marked "(amended during C1)": (a) `FW_EMBED_ALLOWED_ANCESTORS` env → YAML key `embed.allowed_ancestors` (no per-key env overlay exists); (b) capabilities travel on `fieldConnected` (per field), not `hello`, matching the spec's own prose; (c) `client` tag ledger persistence deferred to the next schema-touching story (with B41) — amend BOTH the feature bullet and the Testing bullet that promises "`client` tag validation and ledger recording" (the recording half moves to the deferred story).

- [ ] **Step 1: Write the updates** (follow each doc's existing style: prose + file references).
- [ ] **Step 2: Commit** — `docs(architecture,specs): embed surface, document port, C1 spec amendments (B43 C1)`

---

### Task 11: End-to-end verification round (not CI)

No new files; a scripted verification protocol against a scratch stack. Ports: NEVER 5173/8000 — use 5199 (vite) and 8199 (a second backend with a scratch config: sqlite db under the scratchpad, `environment: dev`, `cors.origins: ["http://localhost:5199"]`, `auth.mode: local` with `ephemeral_secret: true`).

- [ ] **Step 1:** Start the backend on 8199. Boot REQUIRES the admin-seed env vars (names only here; `seed_admin` raises without them): `FW_ADMIN_EMAIL` and `FW_ADMIN_PASSWORD`, and the password must be ≥ 12 characters (`ADMIN_SET_MIN_PASSWORD_LENGTH`, app/core/auth.py) — an 8-char value is a boot failure, not a login page. Then `vite dev --port 5199` with `VITE_API_URL=http://localhost:8199`.
- [ ] **Step 2:** Drive `http://localhost:5199/simulator.html` with Playwright (house headless recipe): Connect → log in inside the iframe (the seeded admin) → assert findings rows appear for the demo text's planted errors → assert overlay marks in the textarea mirror → click a finding in the sidebar (textarea mark flashes) → apply a suggestion → assert the textarea value changed and the finding disappeared → type into the textarea → assert a re-check fires (status strip) and stale findings dropped.
- [ ] **Step 3:** Negative probe via the desync hook: reload as `simulator.html?desync=1`, apply a suggestion → the host refuses (`expectedText` mismatch) → the sidebar shows the `embedReplaceFailed` string; textarea text untouched.
- [ ] **Step 4:** Capture screenshots; kill both servers (only the ones started here).
- [ ] **Step 5:** Commit any fixes found, re-run the relevant unit gates.

---

### Task 12: Wrap-up — PR, review rounds, issues, LOGBOOK

- [ ] **Step 1:** Push `b43-embed-c1`; open the PR against `main` (body: what C1 delivers, the two spec deviations, test evidence incl. the bundle-guard output and e2e screenshots, session trailer; reference the B43/C1 tracking issue on its own line).
- [ ] **Step 2:** Request Copilot review; spawn the background watcher (house convention). Reply to and resolve EVERY comment thread; triage suppressed comments each round.
- [ ] **Step 3:** Whole-branch review by an Opus agent (adversarial: port-refactor regressions, bridge origin pinning, CSP correctness, shim mapping edge cases); fix round + scoped re-review.
- [ ] **Step 4:** Open GH issues for the three deferred items: (a) `llm_usage.client` column + activity attribution (with B41 #126), (b) main-app astral-offset fix, (c) `deploy/fly/config.yaml` `embed.allowed_ancestors` + `test_fly_config.py` guard (lands in C2 with the pinned extension ID).
- [ ] **Step 5:** On Markus's cue: LOGBOOK entry by PR number as the LAST commit on the branch. Owner merges (rebase-merge — large structured branch).

---

## Deferred / follow-ups created by this plan (become GH issues in Task 12)

- `client` column on `llm_usage` + activity attribution — with the next schema-touching story, alongside B41 (#126).
- Main-app astral-offset fix (`editor/findings.ts` consumes backend code points unconverted; `suggest.ts` sends UTF-16 spans back — uniformly wrong in both directions today, so it cancels out there; the embed path is correct after this plan) — pre-existing, backlog issue on merge.
- `deploy/fly/config.yaml` gains `embed.allowed_ancestors` only in C2 (needs the pinned extension ID); `test_fly_config.py` guard lands then.
