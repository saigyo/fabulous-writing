# C3 ContentEditable Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `FieldAdapter` for contentEditable editing hosts — segment-map text model, CSS Custom Highlight API markings, execCommand-first best-effort replacement — wired through the simulator and the browser extension with zero protocol/embed changes.

**Architecture:** A new `segmentMap` module owns text↔DOM correspondence (flat UTF-16 offsets ↔ text nodes, deterministic newline synthesis). `createContentEditableAdapter` builds on it: markings as Highlight registrations behind an injectable sink (no DOM mutation, no geometry syncing), change detection via `input` + MutationObserver coalesced to a microtask, replacement through the browser's real editing pipeline with post-verification. The extension generalizes its textarea-only typing (`detect`/`session`/`reacquire`/`scout`/`affordance`) to `EligibleField`; the simulator gains a second, contentEditable demo field.

**Tech Stack:** TypeScript, Vite, vitest + happy-dom (`// @vitest-environment happy-dom` pragma per test file), Playwright e2e (real Chromium), CSS Custom Highlight API, `document.execCommand`.

**Spec:** docs/superpowers/specs/2026-09-12-c3-contenteditable-adapter-design.md (which amends docs/superpowers/specs/2026-08-22-b43-embeddable-clients-design.md's C3 row)

## Global Constraints

- **Exit criterion (spec):** NO changes under `frontend/src/embed/` — `protocol.ts` stays byte-identical. No backend changes. If a task seems to need one, stop: the plan is wrong.
- **Branch:** all work on `c3-contenteditable-adapter` (already created, carries the spec). Never push to `main`; the PR comes after the plan completes.
- **Commit trailers on EVERY commit**, verbatim:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JXiCFTQQmJeJt3MB8qZdGA
  ```
- **Gates:** frontend (from `frontend/`): `npm test`, `rtk proxy npm run lint`, `npm run build`, `npm run check:embed`. Extension (from `clients/browser-extension/`): `npm test`, `rtk proxy npx oxlint`, `npm run build`. All green before a task's final commit claims completion — with ONE stated exception (plan review BL3): Tasks 5–7 widen types that `scout.ts`/`reacquire.ts` consume, so the extension `npm run build` (its `tsc --noEmit`) is EXPECTED red between Task 5 and Task 8 and those three tasks gate on `vitest run` + `oxlint` only; Task 8 restores and REQUIRES the full build gate.
- **Mutation-verify every guard test:** delete/invert the guard, watch the test fail, restore by RE-EDITING the file (never `git checkout <file>`).
- **Ports 5173 and 8000 are the owner's dev servers — never start, kill, or bind anything there.** The e2e runner uses 8100/8101 and aborts if occupied; respect that.
- **Shell/cwd:** the rtk hook resets cwd between Bash calls — use absolute paths or `git -C /Users/markus/IdeaProjects/fabulous-writing …`; prefix npm/npx/uv commands with `rtk proxy` as shown in the gates above.
- **Highlight styling can only use** `color`, `background-color`, `text-decoration` (+shadow) — `::highlight()` accepts no outline/box properties. Never JS-inject a `<style>` into a host page (CSP — see spec amendment).
- **Naming:** highlight registry names are `fw-error`, `fw-warning`, `fw-suggestion`, `fw-selected`, `fw-flash`. Only ONE adapter may hold active markings per document (protocol's one-connected-field rule makes this true by construction); the module comment must say so.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/simulator/segmentMap.ts` (new) | Text model: build map, `resolvePoint`, `rangeFor`, `offsetAt`, `BLOCK_TAGS` |
| `frontend/src/simulator/segmentMap.test.ts` (new) | Unit tests for the text model |
| `frontend/src/simulator/contentEditableAdapter.ts` (new) | `createContentEditableAdapter` + `HighlightSink` seam + `defaultHighlightSink` |
| `frontend/src/simulator/contentEditableAdapter.test.ts` (new) | Adapter unit tests (fake sink) |
| `frontend/simulator.html`, `frontend/src/simulator/main.ts`, `frontend/src/simulator/simulator.css` | Second demo field, active-field generalization, `::highlight` rules |
| `clients/browser-extension/src/detect.ts` (+test) | `EligibleField`, `fieldKindOf`, `resolveEligibleField`, CE eligibility |
| `clients/browser-extension/src/session.ts` (+test) | Adapter selection by kind, `fieldKind`, caret-based click mapping |
| `clients/browser-extension/src/reacquire.ts` (+test) | Kind-aware fingerprints for CE roots |
| `clients/browser-extension/src/scout.ts` (+test), `affordance.ts` | Type widening; containment-based enter/leave |
| `clients/browser-extension/public/marks.css` | `::highlight()` severity/selected/flash rules |
| `clients/browser-extension/e2e/fixture.html`, `e2e/extension.spec.mjs` | CE fixture field + e2e flow |
| `docs/frontend-architecture.md` | Adapter/simulator section update |

---

### Task 1: segmentMap module

**Files:**
- Create: `frontend/src/simulator/segmentMap.ts`
- Test: `frontend/src/simulator/segmentMap.test.ts`

**Interfaces:**
- Consumes: nothing (DOM only).
- Produces (Tasks 2, 3, 6 rely on these exact names):
  ```ts
  export const BLOCK_TAGS: Set<string>
  export interface Segment { node: Text; start: number }
  export interface SegmentMap { text: string; segments: Segment[] }
  export function buildSegmentMap(root: HTMLElement): SegmentMap
  export function resolvePoint(map: SegmentMap, offset: number, bias: 'start' | 'end'): { node: Text; offset: number } | null
  export function rangeFor(map: SegmentMap, from: number, to: number): Range | null
  export function offsetAt(map: SegmentMap, node: Node, nodeOffset: number): number | null
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/simulator/segmentMap.test.ts` (start with `// @vitest-environment happy-dom`). Test cases — each builds a `<div>` via `innerHTML` in `beforeEach`-created containers:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildSegmentMap, offsetAt, rangeFor, resolvePoint } from './segmentMap'

function rootWith(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('buildSegmentMap', () => {
  it('extracts plain text with no markup verbatim', () => {
    const map = buildSegmentMap(rootWith('hello world'))
    expect(map.text).toBe('hello world')
    expect(map.segments).toHaveLength(1)
    expect(map.segments[0].start).toBe(0)
  })

  it('flattens inline markup without separators', () => {
    const map = buildSegmentMap(rootWith('a <strong>bold <em>nest</em></strong> z'))
    expect(map.text).toBe('a bold nest z')
    // four text nodes: 'a ', 'bold ', 'nest', ' z'
    expect(map.segments.map((s) => s.start)).toEqual([0, 2, 7, 11])
  })

  it('synthesizes one newline per block boundary, collapsed, no leading/trailing', () => {
    expect(buildSegmentMap(rootWith('<div>line1</div><div>line2</div>')).text).toBe('line1\nline2')
    expect(buildSegmentMap(rootWith('a<p>b</p>c')).text).toBe('a\nb\nc')
    // consecutive/empty blocks collapse to a single separator
    expect(buildSegmentMap(rootWith('<div>a</div><div></div><div>b</div>')).text).toBe('a\nb')
  })

  it('emits a newline per inline <br>; a block-trailing <br> is boundary-only', () => {
    expect(buildSegmentMap(rootWith('a<br>b')).text).toBe('a\nb')
    // Chrome's blank line (<div><br></div>, what Enter-Enter produces in a
    // plain contentEditable) renders as ONE empty line: the block-trailing
    // <br> flushes the pending boundary but adds no newline of its own
    expect(buildSegmentMap(rootWith('<div>a</div><div><br></div><div>b</div>')).text).toBe('a\n\nb')
    // trailing filler <br> inside a block contributes nothing extra
    expect(buildSegmentMap(rootWith('<div>a<br></div><div>b</div>')).text).toBe('a\nb')
    expect(buildSegmentMap(rootWith('a<br>')).text).toBe('a')
    // leading <br> is content: it renders a blank first line
    expect(buildSegmentMap(rootWith('<br>a')).text).toBe('\na')
  })

  it('skips whitespace-only text nodes at block boundaries, keeps inline spaces', () => {
    // pretty-printed host markup (CMS composers, quoted replies)
    expect(buildSegmentMap(rootWith('<div>\n  <p>a</p>\n  <p>b</p>\n</div>')).text).toBe('a\nb')
    // a real inter-word space between inline elements is text
    expect(buildSegmentMap(rootWith('<em>a</em> <em>b</em>')).text).toBe('a b')
  })

  it('skips script/style/noscript/template subtrees', () => {
    const map = buildSegmentMap(rootWith('a<style>.x{}</style><script>1</script>b'))
    expect(map.text).toBe('ab')
  })

  it('keeps UTF-16 units: an astral char counts 2', () => {
    const map = buildSegmentMap(rootWith('x𝄞y'))
    expect(map.text).toBe('x𝄞y')
    expect(map.text.length).toBe(4)
  })
})

describe('resolvePoint / rangeFor', () => {
  it('resolves offsets inside a text node for both biases', () => {
    const root = rootWith('abc')
    const map = buildSegmentMap(root)
    expect(resolvePoint(map, 1, 'start')).toEqual({ node: map.segments[0].node, offset: 1 })
    expect(resolvePoint(map, 1, 'end')).toEqual({ node: map.segments[0].node, offset: 1 })
  })

  it('snaps a start on a synthetic newline forward, an end backward', () => {
    const root = rootWith('<div>ab</div><div>cd</div>') // "ab\ncd", '\n' at offset 2
    const map = buildSegmentMap(root)
    const start = resolvePoint(map, 2, 'start')
    expect(start?.node.data).toBe('cd')
    expect(start?.offset).toBe(0)
    const end = resolvePoint(map, 3, 'end') // to=3 ends just past the newline
    expect(end?.node.data).toBe('ab')
    expect(end?.offset).toBe(2)
  })

  it('rangeFor spans across block boundaries', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const map = buildSegmentMap(root)
    const range = rangeFor(map, 1, 4) // "b\nc"
    expect(range).not.toBeNull()
    expect(range?.startContainer.textContent).toBe('ab')
    expect(range?.startOffset).toBe(1)
    expect(range?.endContainer.textContent).toBe('cd')
    expect(range?.endOffset).toBe(1)
  })

  it('rangeFor refuses empty and synthetic-only spans', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const map = buildSegmentMap(root)
    expect(rangeFor(map, 2, 2)).toBeNull()
    expect(rangeFor(map, 2, 3)).toBeNull() // the '\n' alone: start snaps past end
  })
})

describe('offsetAt', () => {
  it('maps a text-node caret to its flat offset, clamped to node length', () => {
    const root = rootWith('a <strong>bb</strong> c')
    const map = buildSegmentMap(root) // "a bb c"
    const bb = map.segments[1].node
    expect(offsetAt(map, bb, 1)).toBe(3)
    expect(offsetAt(map, bb, 99)).toBe(4)
  })

  it('maps an element caret to the nearest following text position', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const map = buildSegmentMap(root)
    // caret "before child index 1" of root = between the two divs -> start of 'cd'
    expect(offsetAt(map, root, 1)).toBe(3)
    // caret after the last child -> end of text
    expect(offsetAt(map, root, 2)).toBe(5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npx vitest run src/simulator/segmentMap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `segmentMap.ts`**

```ts
// Text model for contentEditable fields (spec: B43 C3, "Text model: the
// segment map"). One authority for text<->DOM correspondence: extraction,
// flat-offset->Range resolution (markings, replacement), and DOM-caret->
// flat-offset mapping (click-to-select) all read the same map, so they can
// never disagree about what offset N means. Deterministic and DOM-based,
// deliberately diverging from CSS-driven innerText (which depends on
// computed styles/layout): correctness needs the embed to check exactly the
// text this module extracts — findings offsets come back relative to that
// same text — not visual fidelity to the page. Offsets are UTF-16 code
// units, the protocol's normative unit; string.length arithmetic is exactly
// right and astral characters need no special handling.
// The walk is plain recursion over childNodes (not TreeWalker): identical
// semantics, and happy-dom implements childNodes without surprises.

export const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DD', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TR', 'TD', 'TH', 'UL',
])

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

export interface Segment { node: Text; start: number }
export interface SegmentMap { text: string; segments: Segment[] }

export function buildSegmentMap(root: HTMLElement): SegmentMap {
  const segments: Segment[] = []
  let text = ''
  // Block-boundary newlines are PENDING, not eager: they flush (as a single
  // '\n', however many boundaries queued up) only when more content
  // actually arrives, and only once any content exists at all — no leading
  // newline, no trailing newline, consecutive/empty blocks collapse to one
  // separator.
  //
  // <br> semantics match what Chrome's contentEditable actually renders
  // (plan review SF3): an INLINE <br> (content follows it inside its
  // parent) is content — it flushes a pending boundary, then contributes
  // its own '\n', so '<br>a' extracts '\na'. A BLOCK-TRAILING <br> (the
  // last content-producing child of its parent — Chrome's Enter-Enter
  // filler, `<div><br></div>`, and the trailing filler in `<div>a<br></div>`)
  // is boundary-only: it flushes the pending boundary and then QUEUES one,
  // adding no '\n' of its own — Chrome renders those as a single blank
  // line / nothing, not two.
  //
  // Whitespace-only text nodes at block boundaries (pretty-printed host
  // markup) are skipped (plan review SF4); a whitespace run between INLINE
  // siblings is real text and kept.
  let pendingBreak = false
  function flushBreak(): void {
    if (pendingBreak) {
      if (text.length > 0) text += '\n'
      pendingBreak = false
    }
  }
  function isBlockElement(n: Node | null): boolean {
    return n !== null && n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((n as Element).tagName)
  }
  // True when no LATER sibling of `child` produces content: only
  // whitespace-only text nodes and SKIP_TAGS elements may follow.
  function isLastContentChild(child: Node): boolean {
    for (let n = child.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        if ((n as Text).data.trim().length > 0) return false
        continue
      }
      if (n.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has((n as Element).tagName)) return false
    }
    return true
  }
  function walk(node: Node): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child as Text
        if (t.data.length === 0) continue
        // SF4: formatting whitespace between blocks is not text.
        if (
          t.data.trim().length === 0 &&
          (pendingBreak || isBlockElement(t.previousSibling) || isBlockElement(t.nextSibling))
        ) continue
        flushBreak()
        segments.push({ node: t, start: text.length })
        text += t.data
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const tag = (child as Element).tagName
      if (SKIP_TAGS.has(tag)) continue
      if (tag === 'BR') {
        flushBreak()
        if (isLastContentChild(child)) pendingBreak = true // boundary-only (SF3)
        else text += '\n'
        continue
      }
      const isBlock = BLOCK_TAGS.has(tag)
      if (isBlock) pendingBreak = true
      walk(child)
      if (isBlock) pendingBreak = true
    }
  }
  walk(root)
  return { text, segments }
}

// Flat offset -> a concrete (text node, in-node offset). An offset that
// falls on a synthetic newline (which belongs to no node) snaps FORWARD to
// the next text node for a range start and BACKWARD to the previous text
// node's end for a range end — so a span that merely brushes a block
// boundary still selects exactly its visible characters. null when no text
// node exists on the required side (e.g. a span lying entirely inside
// synthetic newlines).
export function resolvePoint(
  map: SegmentMap, offset: number, bias: 'start' | 'end',
): { node: Text; offset: number } | null {
  if (bias === 'start') {
    for (const seg of map.segments) {
      if (offset <= seg.start) return { node: seg.node, offset: 0 }
      const end = seg.start + seg.node.data.length
      if (offset < end) return { node: seg.node, offset: offset - seg.start }
    }
    return null
  }
  for (let i = map.segments.length - 1; i >= 0; i--) {
    const seg = map.segments[i]
    const end = seg.start + seg.node.data.length
    if (offset >= end) return { node: seg.node, offset: seg.node.data.length }
    if (offset > seg.start) return { node: seg.node, offset: offset - seg.start }
  }
  return null
}

export function rangeFor(map: SegmentMap, from: number, to: number): Range | null {
  if (to <= from) return null
  const start = resolvePoint(map, from, 'start')
  const end = resolvePoint(map, to, 'end')
  if (!start || !end) return null
  // A synthetic-only span snaps its start PAST its end (start bias forward,
  // end bias backward); Range.setEnd would silently collapse to the end
  // point, so compare first and refuse instead. This inverted check IS the
  // synthetic-only refusal — passing it guarantees a non-collapsed range
  // (same node implies end.offset > start.offset), so no further guard.
  const rel = start.node.compareDocumentPosition(end.node)
  const inverted = start.node === end.node
    ? end.offset <= start.offset
    : Boolean(rel & Node.DOCUMENT_POSITION_PRECEDING)
  if (inverted) return null
  const range = start.node.ownerDocument.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

// DOM caret -> flat offset. A caret in a mapped text node is exact; a caret
// between elements resolves to the nearest FOLLOWING mapped position (the
// segment about to start), or the end of the text when nothing follows.
// null only for a node that belongs to a different tree than the map's.
export function offsetAt(map: SegmentMap, node: Node, nodeOffset: number): number | null {
  const seg = map.segments.find((s) => s.node === node)
  if (seg) return seg.start + Math.min(nodeOffset, seg.node.data.length)
  if (node.nodeType === Node.TEXT_NODE) {
    // A text node not in the map (inside a skipped subtree, or a foreign
    // tree): fall through to the element-style resolution via its parent.
    const parent = node.parentNode
    if (!parent) return null
    return offsetAt(map, parent, Array.prototype.indexOf.call(parent.childNodes, node))
  }
  const anchor: Node | null = node.childNodes[nodeOffset] ?? null
  if (anchor === null) {
    // Caret after the last child: first segment strictly following `node`
    // itself (not contained by it), else the end of the text.
    for (const s of map.segments) {
      const rel = node.compareDocumentPosition(s.node)
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING && !(rel & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
        return s.start
      }
    }
    return map.text.length
  }
  for (const s of map.segments) {
    if (s.node === anchor) return s.start
    const rel = anchor.compareDocumentPosition(s.node)
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING || rel & Node.DOCUMENT_POSITION_CONTAINED_BY) {
      return s.start
    }
  }
  return map.text.length
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npx vitest run src/simulator/segmentMap.test.ts`
Expected: PASS. If a happy-dom quirk breaks a case (e.g. `compareDocumentPosition`), fix the implementation, not the semantics; note any quirk in a comment the way `textareaAdapter.ts` does.

- [ ] **Step 5: Mutation-verify one guard**

Temporarily change `if (inverted) return null` to `if (false) return null` — the synthetic-only-span test (`rangeFor(2, 3)` → null) must fail. Restore by re-editing. Then run the file's tests again: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add frontend/src/simulator/segmentMap.ts frontend/src/simulator/segmentMap.test.ts
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(simulator): segment map text model for contentEditable (B43 C3)"
```
(with the Global Constraints trailers appended, here and in every later commit)

---

### Task 2: contentEditableAdapter — extraction, markings, change detection

**Files:**
- Create: `frontend/src/simulator/contentEditableAdapter.ts`
- Test: `frontend/src/simulator/contentEditableAdapter.test.ts`

**Interfaces:**
- Consumes (Task 1): `buildSegmentMap`, `rangeFor`, `offsetAt`, types `SegmentMap`.
- Consumes (existing): `FieldAdapter`, `MarkingSpan` from `../embed/protocol` (READ-ONLY import — never edit that file). (No `SEVERITIES` import — the severity list is spelled locally in `SEVERITY_PRIORITY`; an unused import is a lint error.)
- Produces (Tasks 3–6 rely on these exact names):
  ```ts
  export interface HighlightSink {
    set(name: string, ranges: Range[], priority: number): void
    clear(name: string): void
  }
  export function defaultHighlightSink(): HighlightSink | null
  export interface ContentEditableAdapter extends FieldAdapter {
    caretOffset(): number | null
  }
  export function createContentEditableAdapter(
    root: HTMLElement, sink?: HighlightSink | null,
  ): ContentEditableAdapter
  ```
  (`sink` defaults to `defaultHighlightSink()`; passing an explicit sink is the test seam.)

Task 2 implements everything EXCEPT `applyReplacement` and `caretOffset` (Task 3): those two methods exist but are stubs returning `{ ok: false, text: extract() }` / `null`, clearly marked `// Task 3`.

- [ ] **Step 1: Write the failing tests**

`contentEditableAdapter.test.ts` (with the happy-dom pragma). A fake sink records calls:

```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContentEditableAdapter, type HighlightSink } from './contentEditableAdapter'
import type { MarkingSpan } from '../embed/protocol'

function fakeSink() {
  const entries = new Map<string, { ranges: Range[]; priority: number }>()
  const sink: HighlightSink = {
    set: (name, ranges, priority) => { entries.set(name, { ranges, priority }) },
    clear: (name) => { entries.delete(name) },
  }
  return { sink, entries }
}

function rootWith(html: string): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

const span = (id: string, from: number, to: number, severity: MarkingSpan['severity'] = 'error'): MarkingSpan =>
  ({ id, from, to, severity, category: 'grammar' })
```

Cases to cover (each an `it`, with `afterEach` disposing the adapter and emptying `document.body`):

1. **capabilities**: with a sink → `{ mark: 'native', replace: 'best-effort' }`; with `sink: null` → `{ mark: 'none', replace: 'best-effort' }`.
2. **extract** returns the segment-map text (`'a\nb'` for `<div>a</div><div>b</div>`).
3. **setMarkings groups by severity with the right names/priorities**: two error spans + one warning → `entries` has `fw-error` (2 ranges, priority 3) and `fw-warning` (1 range, priority 2), no `fw-suggestion`.
4. **setMarkings clamps and drops**: a span beyond text length is clamped; a span that collapses (or resolves to synthetic-only) contributes no range; a severity left with zero ranges gets `clear`ed (seed it first with a prior `setMarkings`).
5. **clearMarkings** clears all severity names AND `fw-selected`/`fw-flash`.
6. **setSelected**: selecting an existing id sets `fw-selected` (priority 4) with that one range; `setSelected(null)` clears it; selecting keeps working after a later `setMarkings` (re-applied on every reapply).
7. **flashFinding**: sets `fw-flash` (priority 5); after 700 ms (`vi.useFakeTimers`) it is cleared; a second flash before expiry resets the timer (only one clear).
8. **change detection — input**: mutate a text node's `data`, dispatch `new InputEvent('input', { bubbles: true })` from an inner node, `await Promise.resolve()` (microtask flush) → `onChange` cb fired once, `extract()` reflects the new text, and the recorded `fw-error` entry was rebuilt (new Range identity for the same id).
9. **change detection — MutationObserver**: append a new `<div>tail</div>` without any input event; `await new Promise(r => setTimeout(r))` (observer callbacks are macrotask-ish under happy-dom) → cb fired, text updated. If happy-dom's MutationObserver never delivers, mark the case with the same guarded-skip pattern the textarea tests use for ResizeObserver (`typeof MutationObserver` guard is NOT acceptable — it exists; only skip if delivery provably never happens under happy-dom, and then note it and rely on e2e).
10. **no notification when text is unchanged**: wrap an existing text node in a `<span>` (childList mutation, same extracted text) → highlights re-anchored but cb NOT fired.
11. **dispose**: after `dispose()`, all five names cleared, a further DOM change fires no cb, a pending flash timer never fires (`vi.runAllTimers` after dispose → no `clear` call beyond dispose's own).
12. **default sink null-path**: `createContentEditableAdapter(root, null)` — `setMarkings`/`flashFinding`/`setSelected` are safe no-ops (no throw).
13. **defaultHighlightSink real path**: stub `globalThis.CSS = { highlights: new Map() }`-shaped registry and a `globalThis.Highlight` fake class (constructor captures ranges, instance carries `priority`) → `defaultHighlightSink()` non-null; `set` constructs a Highlight with the ranges, assigns `priority`, registers under the name; `clear` deletes it. Delete the stubs in `afterEach` so the accessor's undefined branch (the `mark: 'none'` gate) stays covered by the other cases.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npx vitest run src/simulator/contentEditableAdapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter (minus Task 3's methods)**

```ts
// ContentEditable FieldAdapter (spec: B43 C3). Reference implementation for
// the simulator's contentEditable demo field AND the module the C2/C3
// browser extension lifts directly (same dual role as textareaAdapter.ts).
//
// Markings are CSS Custom Highlight API registrations — no DOM mutation, no
// mirror overlay, no geometry syncing. The ::highlight(fw-*) rules ship per
// host stylesheet (simulator.css; the extension's manifest-declared
// marks.css) — NEVER as a JS-injected <style>, which strict-CSP host pages
// silently reject (marks.css's own header records that C2 lesson).
//
// Highlight names (fw-error/-warning/-suggestion/-selected/-flash) are
// document-global: only ONE adapter may hold active markings per document
// at a time. The bridge protocol's one-connected-field rule guarantees that
// — hosts only feed markings to the connected field's adapter.
import type { FieldAdapter, MarkingSpan } from '../embed/protocol'
import { buildSegmentMap, offsetAt, rangeFor, type SegmentMap } from './segmentMap'

const FLASH_MS = 700 // same pulse duration as textareaAdapter.ts

// Priorities: flash over selected over severities, severe over mild — a
// higher priority paints on top where highlights overlap.
const SEVERITY_PRIORITY = { error: 3, warning: 2, suggestion: 1 } as const
const SELECTED_PRIORITY = 4
const FLASH_PRIORITY = 5
const ALL_NAMES = ['fw-error', 'fw-warning', 'fw-suggestion', 'fw-selected', 'fw-flash'] as const

export interface HighlightSink {
  set(name: string, ranges: Range[], priority: number): void
  clear(name: string): void
}

// lib.dom's Highlight/CSS.highlights typings aren't guaranteed at this
// project's TS config; access through structural types so the build never
// depends on them.
interface HighlightLike { priority: number }
export function defaultHighlightSink(): HighlightSink | null {
  const g = globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => HighlightLike
    CSS?: { highlights?: { set(n: string, h: HighlightLike): void; delete(n: string): boolean } }
  }
  const registry = g.CSS?.highlights
  const Ctor = g.Highlight
  if (!registry || !Ctor) return null
  return {
    set(name, ranges, priority) {
      const highlight = new Ctor(...ranges)
      highlight.priority = priority
      registry.set(name, highlight)
    },
    clear(name) { registry.delete(name) },
  }
}

export interface ContentEditableAdapter extends FieldAdapter {
  caretOffset(): number | null
}

export function createContentEditableAdapter(
  root: HTMLElement,
  sink: HighlightSink | null = defaultHighlightSink(),
): ContentEditableAdapter {
  let map: SegmentMap = buildSegmentMap(root)
  let changeCb: (() => void) | null = null
  let currentSpans: MarkingSpan[] = []
  let selectedId: string | null = null
  let flashId: string | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function clampedSpans(): MarkingSpan[] {
    return currentSpans
      .map((s) => ({
        ...s,
        from: Math.max(0, Math.min(s.from, map.text.length)),
        to: Math.max(0, Math.min(s.to, map.text.length)),
      }))
      .filter((s) => s.to > s.from)
  }

  // Rebuild every Highlight registration from the CURRENT spans against the
  // CURRENT map — the one place ranges are ever created, so they can never
  // dangle across DOM mutations (spec: "re-anchored on every change tick").
  function reapplyHighlights(): void {
    if (!sink) return
    const clamped = clampedSpans()
    for (const severity of ['error', 'warning', 'suggestion'] as const) {
      const ranges = clamped
        .filter((s) => s.severity === severity)
        .map((s) => rangeFor(map, s.from, s.to))
        .filter((r): r is Range => r !== null)
      if (ranges.length > 0) sink.set(`fw-${severity}`, ranges, SEVERITY_PRIORITY[severity])
      else sink.clear(`fw-${severity}`)
    }
    applySingle('fw-selected', selectedId, SELECTED_PRIORITY, clamped)
    applySingle('fw-flash', flashId, FLASH_PRIORITY, clamped)
  }

  function applySingle(
    name: string, id: string | null, priority: number, clamped: MarkingSpan[],
  ): void {
    if (!sink) return
    const target = id === null ? undefined : clamped.find((s) => s.id === id)
    const range = target ? rangeFor(map, target.from, target.to) : null
    if (range) sink.set(name, [range], priority)
    else sink.clear(name)
  }

  // input (user edits, incl. inside framework editors) and the observer
  // (programmatic/framework rewrites that fire no input) both funnel into
  // one microtask-coalesced sync. onChange only fires when the EXTRACTED
  // text actually changed — a markup-only rewrite (e.g. a span wrapped
  // around existing text) re-anchors highlights but sends no textChanged.
  // The change baseline is `notifiedText`, NOT the map itself (plan review
  // BL1): applyReplacement rebuilds `map` synchronously mid-apply, and a
  // baseline derived from `map` at tick time would then see "no change" and
  // swallow the very textChanged the replacement must produce. A model-
  // driven editor re-rendering per keystroke re-runs this tick per
  // keystroke (full map rebuild + range re-creation) — fine at composer
  // size, unbounded by design; recorded as an accepted risk, not throttled.
  let notifiedText = map.text
  let syncQueued = false
  function queueSync(): void {
    if (syncQueued || disposed) return
    syncQueued = true
    queueMicrotask(() => {
      syncQueued = false
      if (disposed) return
      map = buildSegmentMap(root)
      reapplyHighlights()
      if (map.text !== notifiedText) {
        notifiedText = map.text
        changeCb?.()
      }
    })
  }

  function handleInput(): void { queueSync() }
  root.addEventListener('input', handleInput)
  const observer = new MutationObserver(queueSync)
  observer.observe(root, { childList: true, characterData: true, subtree: true })

  return {
    capabilities: () => ({ mark: sink ? 'native' : 'none', replace: 'best-effort' }),
    extract: () => map.text,
    onChange(cb) { changeCb = cb },
    applyReplacement(_from, _to, _insert, _expectedText) {
      // Task 3
      return { ok: false, text: map.text }
    },
    setMarkings(spans) {
      currentSpans = spans
      reapplyHighlights()
    },
    clearMarkings() {
      currentSpans = []
      selectedId = null
      // an in-flight flash has nothing left to point at
      flashId = null
      if (flashTimer !== null) { clearTimeout(flashTimer); flashTimer = null }
      reapplyHighlights()
    },
    flashFinding(id) {
      if (!sink) return
      const target = clampedSpans().find((s) => s.id === id)
      if (!target) return
      const range = rangeFor(map, target.from, target.to)
      if (!range) return
      // Bring the finding on screen — the Highlight paints wherever the
      // range is, but the user still needs the viewport moved there.
      // scrollIntoView on the start container's element parent is the
      // best-effort equivalent of the textarea adapter's scrollTop math.
      ;(range.startContainer.parentElement ?? root).scrollIntoView?.({ block: 'nearest' })
      flashId = id
      reapplyHighlights()
      if (flashTimer !== null) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => {
        flashTimer = null
        flashId = null
        reapplyHighlights()
      }, FLASH_MS)
    },
    setSelected(id) {
      selectedId = id
      reapplyHighlights()
    },
    caretOffset() {
      // Task 3
      return null
    },
    dispose() {
      disposed = true
      root.removeEventListener('input', handleInput)
      observer.disconnect()
      if (flashTimer !== null) { clearTimeout(flashTimer); flashTimer = null }
      changeCb = null
      if (sink) for (const name of ALL_NAMES) sink.clear(name)
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npx vitest run src/simulator/contentEditableAdapter.test.ts`
Expected: PASS (Task 3's two stub-covering cases are written in Task 3, not here).

- [ ] **Step 5: Mutation-verify**

Delete the `if (map.text !== prevText)` guard (always call cb) — the "no notification when text unchanged" test must fail. Restore by re-editing; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add frontend/src/simulator/contentEditableAdapter.ts frontend/src/simulator/contentEditableAdapter.test.ts
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(simulator): contentEditable adapter — markings + change detection (B43 C3)"
```

---

### Task 3: contentEditableAdapter — applyReplacement + caretOffset

**Files:**
- Modify: `frontend/src/simulator/contentEditableAdapter.ts` (replace the two Task-3 stubs)
- Test: `frontend/src/simulator/contentEditableAdapter.test.ts` (append cases)

**Interfaces:**
- Consumes: Task 1's `rangeFor`, `offsetAt`; Task 2's module structure.
- Produces: the finished `ContentEditableAdapter` Tasks 4 and 6 wire up.

- [ ] **Step 1: Write the failing tests** (append to the Task 2 file)

Cases:

1. **refuses malformed vectors** (non-integer, negative, `to < from`, `to > text.length`) with `{ ok: false, text: <current> }` and an UNCHANGED DOM — mirrors `textareaAdapter.ts`'s finding-6 ordering: validation BEFORE the expectedText compare.
2. **refuses an expectedText mismatch** without mutating.
3. **applies a same-node replacement via the fallback path** (happy-dom has no `execCommand` — the surgery branch IS the tested branch, exactly like the textarea adapter's own tests): `<div>The quikc fox</div>`, replace `[4,9) 'quikc'` → `'quick'`; expect `{ ok: true, text: 'The quick fox' }`, DOM textContent updated, and a bubbling `input` event was dispatched from the root (listen on `document`).
4. **applies across an inline-markup boundary**: `a <strong>bd</strong> c`, replace `[2,4) 'bd'` → `'bold'` — ok:true, extract `'a bold c'`.
5. **empty insert deletes**: replace `[2,4)` with `''` → ok:true, text shrank by 2 (the length-delta term of the post-verify is what validates a deletion — `''`'s slice check is vacuous).
6. **post-verification failure returns ok:false with the real text**: install a `document` input listener that immediately rewrites the root's content to `'REWRITTEN'` (synchronously, framework-style), apply a replacement → `{ ok: false, text: 'REWRITTEN' }` — never a throw, never a lie.
7. **refuses when the span resolves to no Range** (a from/to pair lying entirely on a synthetic newline, e.g. `[2,3)` in `<div>ab</div><div>cd</div>`) — refuses WITHOUT mutating: the DOM stays byte-identical (plan review BL2).
8. **caretOffset**: stub `document.getSelection` (`vi.spyOn`) to return `{ rangeCount: 1, anchorNode, anchorOffset }`-shaped objects — a caret inside a mapped text node returns the flat offset; a caret outside `root` (anchorNode not contained) returns null; no selection → null.
9. **replacement fires onChange** (via the input event → microtask sync) with the NEW text — the session/simulator sends textChanged after an apply, same as the textarea path. (This is the test that pins plan review BL1's `notifiedText` baseline.)
10. **failed deletion is reported**: a `document` input listener restores the original text after an empty-insert deletion → `{ ok: false, text: <restored> }` — the length-delta term of the post-verify is the only thing that can catch this (SF2's mutation target).
11. **cross-block surgery refuses before mutating** (plan review SF5): `<div>ab</div><div>cd</div>`, replace `[1,4) 'b\nc'` → in the surgery branch (happy-dom) the span contains a synthetic newline that `deleteContents` cannot remove — expect `{ ok: false, text: 'ab\ncd' }` and an UNCHANGED DOM.
12. **degenerate no-op request**: `from === to` with `insert === ''` → `{ ok: true, text }` immediately, DOM untouched (plan review SF6 — `execCommand('delete')` on a collapsed selection would backspace a character the request never named).
13. **insertion into an empty field refuses**: an empty CE root (`''`), `applyReplacement(0, 0, 'x', '')` → ok:false (no text node to anchor a collapsed range on — documented limitation N6; findings require text, so no real flow reaches this).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npx vitest run src/simulator/contentEditableAdapter.test.ts`
Expected: the new cases FAIL against the stubs.

- [ ] **Step 3: Implement**

Replace the stubs:

```ts
    applyReplacement(from, to, insert, expectedText) {
      // A queued (not-yet-flushed) sync could leave `map` stale against the
      // live DOM; a replacement must judge against reality, so rebuild
      // synchronously first — cheap, and it makes the microtask queue
      // irrelevant to correctness here.
      map = buildSegmentMap(root)
      const text = map.text
      // Finding-6 ordering (textareaAdapter.ts): validate the vector BEFORE
      // the expectedText compare — slice() silently clamps, so a crafted
      // expectedText matching the CLAMPED slice would otherwise mutate at
      // the wrong position instead of being refused.
      if (
        !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to < from || to > text.length
      ) {
        return { ok: false, text }
      }
      if (text.slice(from, to) !== expectedText) {
        return { ok: false, text }
      }
      // Degenerate no-op: nothing to delete, nothing to insert. Returning
      // early matters (plan review SF6) — execCommand('delete') on a
      // COLLAPSED selection is a backspace: it would remove the character
      // before the caret, a character this request never named.
      if (from === to && insert === '') {
        return { ok: true, text }
      }
      const range = rangeFor(map, from, to)
      // A zero-length insertion point (from === to) legitimately has no
      // Range from rangeFor (it refuses empty spans) — build a collapsed
      // one. Gate the fallback on EXACTLY that case (plan review BL2): for
      // from < to, a null range means the span lies on synthetic newlines
      // and MUST refuse — falling back would insert at a snapped position,
      // mutating on a path reported as refused.
      const target = range ?? (from === to
        ? (() => {
            const point = resolvePoint(map, from, 'start') ?? resolvePoint(map, from, 'end')
            if (!point) return null // empty field: no text node to anchor on (N6)
            const r = point.node.ownerDocument.createRange()
            r.setStart(point.node, point.offset)
            r.setEnd(point.node, point.offset)
            return r
          })()
        : null)
      if (!target) return { ok: false, text }
      // Plan review SF5: Range.deleteContents only TRIMS partially
      // contained text nodes — it cannot remove a block boundary, so a
      // cross-block span leaves its synthetic newline behind: mutation
      // followed by ok:false, which the never-corrupt rule forbids. The
      // surgery branch therefore refuses spans whose Range covers less
      // text than [from, to) spans (i.e. synthetic newlines inside) —
      // BEFORE any mutation. Deliberately over-broad in the safe direction
      // (re-review item 3): a <br>-spanning span, which deleteContents
      // WOULD handle (the <br> is fully contained), is refused too — its
      // '\n' is also absent from Range.toString(); and a refusal taken
      // after the selection was already moved leaves the caret at the
      // span, which is accepted (refusals are rare and non-destructive).
      // The execCommand branch stays unguarded:
      // Chrome's real editing pipeline handles cross-block edits the way
      // a user's typing-over-selection would, and post-verification is
      // the arbiter there.
      const canExecCommand = typeof document.execCommand === 'function'
      if (!canExecCommand && target.toString().length !== to - from) {
        return { ok: false, text }
      }

      // M11 (textareaAdapter.ts): recover the REAL focused node through a
      // shadow root before moving focus, so the restore below lands back on
      // e.g. the extension's affordance chip instead of <body>. Scroll
      // position is saved/restored the same way the textarea adapter does —
      // focus + selection changes can scroll an inner-scrolling editable.
      const prev = document.activeElement?.shadowRoot?.activeElement ?? document.activeElement
      const { scrollTop, scrollLeft } = root
      root.focus({ preventScroll: true })
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(target)
      // The real editing pipeline: native undo preserved, beforeinput/input
      // fire, framework editors see the edit through their own model.
      // 'insertText' with an empty string is not a deletion command —
      // 'delete' is (and it only runs for a non-collapsed range: from < to,
      // per the early return above). happy-dom has no execCommand at all,
      // so the typeof guard routes tests through the surgery fallback
      // (which has no undo stack to preserve there anyway).
      const applied =
        canExecCommand &&
        (insert === ''
          ? document.execCommand('delete', false)
          : document.execCommand('insertText', false, insert))
      if (!applied) {
        if (target.toString().length !== to - from) {
          // execCommand existed but refused; same cross-block guard as
          // above before falling back to surgery.
          root.scrollTop = scrollTop
          root.scrollLeft = scrollLeft
          if (prev instanceof HTMLElement && prev !== root) prev.focus({ preventScroll: true })
          return { ok: false, text }
        }
        target.deleteContents()
        if (insert !== '') target.insertNode(document.createTextNode(insert))
        // Must bubble: frameworks delegate input listeners to the document
        // root (same reasoning as textareaAdapter.ts's fallback dispatch).
        root.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
      // Post-verify against the REAL post-edit DOM: a framework that
      // synchronously rewrote the result (its input handler re-rendering
      // from its own model) yields ok:false with the real text, so the
      // embed re-syncs from the echo instead of desyncing — degrade
      // gracefully, never corrupt. (An ASYNC rewrite lands later as an
      // ordinary textChanged via the observer — same self-healing, one
      // message later.) The slice term catches wrong content; the
      // length-delta term is the ONLY check for an empty insert (a
      // deletion the host restored — test case 10).
      map = buildSegmentMap(root)
      const ok = map.text.slice(from, from + insert.length) === insert
        && map.text.length === text.length - (to - from) + insert.length
      root.scrollTop = scrollTop
      root.scrollLeft = scrollLeft
      if (prev instanceof HTMLElement && prev !== root) prev.focus({ preventScroll: true })
      return { ok, text: map.text }
    },
```

(add `resolvePoint` to the segmentMap import), and:

```ts
    caretOffset() {
      const selection = document.getSelection()
      if (!selection || selection.rangeCount === 0) return null
      const { anchorNode, anchorOffset } = selection
      if (!anchorNode || !root.contains(anchorNode)) return null
      // Same synchronous rebuild as applyReplacement (N3): a click can land
      // in the same task as a DOM edit whose sync is still queued, and the
      // caret must be judged against the DOM it actually sits in.
      map = buildSegmentMap(root)
      return offsetAt(map, anchorNode, anchorOffset)
    },
```

- [ ] **Step 4: Run the full frontend suite**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npm test`
Expected: PASS, all files.

- [ ] **Step 5: Mutation-verify (two targets, one per post-verify term)**

1. Remove the length-delta term from the `ok` computation — case 10 (restored deletion) must fail; case 6 still passes (its rewrite trips the slice term).
2. Restore, then replace the whole `ok` expression with `true` — case 6 must fail.

Restore by re-editing; re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add frontend/src/simulator/contentEditableAdapter.ts frontend/src/simulator/contentEditableAdapter.test.ts
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(simulator): contentEditable replacement + caret mapping (B43 C3)"
```

---

### Task 4: Simulator second field

**Files:**
- Modify: `frontend/simulator.html`
- Modify: `frontend/src/simulator/main.ts`
- Modify: `frontend/src/simulator/simulator.css`
- Test: `frontend/src/simulator/main.test.ts` (extend)

**Interfaces:**
- Consumes: `createContentEditableAdapter` (Tasks 2–3), existing `createTextareaAdapter`, `findingIdAt`.
- Produces: the hand-check + e2e harness for the CE adapter. Field ids: textarea keeps `'sim-field'`; the CE field is `'sim-field-ce'`.

- [ ] **Step 1: HTML** — inside `.sim-host`, after the existing `.sim-field-wrap`, add a second wrap and give each field its own Connect button in the toolbar:

```html
<div class="sim-toolbar">
  <button id="connect" type="button">Connect textarea</button>
  <button id="connect-ce" type="button">Connect contentEditable</button>
  <button id="disconnect" type="button" disabled>Disconnect</button>
  <span id="sim-status" class="sim-status">not connected</span>
</div>
...
<div class="sim-field-wrap sim-ce-wrap">
  <div id="field-ce" class="sim-ce" contenteditable="true" spellcheck="false">The <strong>quikc</strong> brown fox could of jumped<br>over the the lazy dog.</div>
</div>
```

- [ ] **Step 2: CSS** — style `.sim-ce` like the textarea (border, padding, min-height, font), and add the `::highlight` rules (severity fills match the simulator's opaque `.fw-mark-*` palette; selected/flash use alpha violet):

```css
/* B43 C3: contentEditable markings. ::highlight() accepts only color /
   background-color / text-decoration(-…) — .fw-mark-selected's outline has
   no equivalent here, hence the underline. */
::highlight(fw-error) { background-color: #f8b4b4; }
::highlight(fw-warning) { background-color: #fde68a; }
::highlight(fw-suggestion) { background-color: #bfdbfe; }
::highlight(fw-selected) { background-color: #6e56cf40; text-decoration: underline; }
::highlight(fw-flash) { background-color: #6e56cf80; }
```

- [ ] **Step 3: main.ts generalization** — replace the single `FIELD_ID`/`adapter` with an active-field record. The shape (preserving every existing guard verbatim — desync one-shots, foreign-fieldId echo, try/catch around apply):

```ts
interface SimField {
  fieldId: string
  fieldKind: string
  el: HTMLElement
  adapter: FieldAdapter & { caretOffset?(): number | null }
}
const ceEl = document.getElementById('field-ce') as HTMLElement
const ceConnectBtn = document.getElementById('connect-ce') as HTMLButtonElement
const textareaField: SimField = { fieldId: 'sim-field', fieldKind: 'textarea', el: fieldEl, adapter: createTextareaAdapter(fieldEl) }
const ceField: SimField = { fieldId: 'sim-field-ce', fieldKind: 'contenteditable', el: ceEl, adapter: createContentEditableAdapter(ceEl) }
let active: SimField | null = null
```

- `connect`/`connect-ce` click: if `!ready` return; clear the OTHER field's markings/selection, set `active`, send `fieldConnected` with that field's id/kind/capabilities/text (`connected = true` becomes `active !== null`).
- Both adapters' `onChange` callbacks: only forward when their field IS `active` (the desync one-shot logic applies to whichever is active — move the suppress/mutate branches into a shared `handleChange(field)`).
- Click-to-select: textarea keeps `selectionStart`; the CE field's click handler uses `ceField.adapter.caretOffset?.()` (null → return).
- Every embed-message handler keys on `active` and `msg.payload.fieldId === active.fieldId`; the desync mutate hook for the CE field prepends `_` via `ceEl.prepend('_')` (a real DOM mutation) instead of `fieldEl.value`.
- iframe `load` reset + Disconnect clear BOTH adapters' markings and null `active`.
- `beforeunload` disposes both adapters.

- [ ] **Step 4: Extend `main.test.ts`.** FIRST (plan review SF7): `main.ts` resolves its elements at import time with non-null casts, and the test file's `setUpFixture()` recreates simulator.html's DOM — add `#field-ce` (a contentEditable div) and `#connect-ce` to `setUpFixture()` before anything else, or every EXISTING test in the file throws at import. Then cover: connecting the CE field sends `fieldConnected` with `fieldKind: 'contenteditable'` and the CE text; connecting one field after the other clears the first's markings; a `findings` message for the inactive fieldId is ignored; applyReplacement routes to the active adapter. Follow the file's existing harness pattern (it already fakes the iframe/postMessage plumbing — read it first).

- [ ] **Step 5: Run gates**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npm test && rtk proxy npm run lint && rtk proxy npm run build && rtk proxy npm run check:embed`
Expected: all green.

- [ ] **Step 6: Hand-check note (do not skip):** start nothing yourself — ports 5173/8000 belong to the owner. Record in the task report that the simulator hand-check (`/simulator.html` on the owner's dev server: connect CE field → findings paint as highlights → apply suggestion → undo works) is deferred to the owner's own session, same as C1/C2 did.

- [ ] **Step 7: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add frontend/simulator.html frontend/src/simulator/main.ts frontend/src/simulator/main.test.ts frontend/src/simulator/simulator.css
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(simulator): second contentEditable demo field (B43 C3)"
```

---

### Task 5: detect.ts generalization

**Files:**
- Modify: `clients/browser-extension/src/detect.ts`
- Test: `clients/browser-extension/src/detect.test.ts` (extend)

**Interfaces:**
- Produces (Tasks 6–8 rely on these exact names):
  ```ts
  export type EligibleField = HTMLTextAreaElement | HTMLElement
  export type FieldKind = 'textarea' | 'contenteditable'
  export function fieldKindOf(el: EligibleField): FieldKind
  export function isEligibleField(el: EventTarget | null): el is EligibleField
  /** Climb from an inner node of an editable region to its eligible root; identity for an already-eligible target; null otherwise. */
  export function resolveEligibleField(target: EventTarget | null): EligibleField | null
  ```

- [ ] **Step 1: Write the failing tests** (extend `detect.test.ts`, following its existing size/visibility stubbing pattern — read it first):

> **Gate note (plan review BL3):** this task and Tasks 6–7 widen types that `scout.ts`/`reacquire.ts` still consume with the old `HTMLTextAreaElement` signatures, so the extension's `npm run build` (`tsc --noEmit`) is EXPECTED red until Task 8 widens those. Tasks 5–7 gate on `rtk proxy npx vitest run <file>` + `rtk proxy npx oxlint` only; a reviewer accepts them on that basis.

Remember (plan review N8): happy-dom rects default to 0×0 — stub `getBoundingClientRect` on every element a case needs eligible (the host root in cases 2 and 4 included), the same way the file's existing tests do.

1. an editing host (`contenteditable="true"` div, parent not editable, ≥ min size) is eligible; `fieldKindOf` → `'contenteditable'`.
2. an INNER child of an editing host is NOT itself eligible, but `resolveEligibleField(innerSpan)` returns the host root.
3. `contenteditable="false"` → ineligible (`isContentEditable` false).
4. a nested editing host whose PARENT is also editable is not a root → ineligible directly; `resolveEligibleField` climbs to the outermost editable ancestor.
5. size gate applies to CE hosts exactly like textareas.
6. textarea behavior unchanged (existing tests keep passing); `fieldKindOf(textarea)` → `'textarea'`.
7. `resolveEligibleField` on an eligible textarea returns it; on `null`/body → null.

- [ ] **Step 2: Run to verify FAIL**, `cd /Users/markus/IdeaProjects/fabulous-writing/clients/browser-extension && rtk proxy npx vitest run src/detect.test.ts`

- [ ] **Step 3: Implement**

```ts
export type EligibleField = HTMLTextAreaElement | HTMLElement
export type FieldKind = 'textarea' | 'contenteditable'

export function fieldKindOf(el: EligibleField): FieldKind {
  return el instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
}

function editingRootOf(el: HTMLElement): HTMLElement {
  let root = el
  while (root.parentElement?.isContentEditable) root = root.parentElement
  return root
}

function meetsSize(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.width >= MIN_FIELD_WIDTH && rect.height >= MIN_FIELD_HEIGHT
}

export function isEligibleField(el: EventTarget | null): el is EligibleField {
  if (el instanceof HTMLTextAreaElement) {
    const isDisabled = el.disabled || (el.closest('fieldset:disabled') !== null) || el.matches(':disabled')
    if (isDisabled || el.readOnly) return false
    return meetsSize(el)
  }
  // ContentEditable EDITING HOSTS only — the root of the editable region
  // (parent not editable), never inner nodes. isContentEditable is already
  // false under a contenteditable="false" ancestor. No disabled/readonly
  // analogue exists for contentEditable.
  if (el instanceof HTMLElement && el.isContentEditable && !el.parentElement?.isContentEditable) {
    return meetsSize(el)
  }
  return false
}

export function resolveEligibleField(target: EventTarget | null): EligibleField | null {
  if (isEligibleField(target)) return target
  if (target instanceof HTMLElement && target.isContentEditable) {
    const root = editingRootOf(target)
    if (isEligibleField(root)) return root
  }
  return null
}
```
(keep the existing header comment, extend it: v1's "textarea-only" note is now "textarea + contentEditable editing hosts; `<input>` still deliberately ineligible".)

- [ ] **Step 4: Run to verify PASS**, then **Step 5: Mutation-verify** — drop the `!el.parentElement?.isContentEditable` root condition; the nested-host test must fail; restore by re-editing.

- [ ] **Step 6: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add clients/browser-extension/src/detect.ts clients/browser-extension/src/detect.test.ts
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(extension): contentEditable field eligibility + root resolution (B43 C3)"
```

---

### Task 6: session.ts generalization

**Files:**
- Modify: `clients/browser-extension/src/session.ts`
- Test: `clients/browser-extension/src/session.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `EligibleField`, `fieldKindOf`; Tasks 2–3's `createContentEditableAdapter` (import path `../../../frontend/src/simulator/contentEditableAdapter`, same relative style as the existing textarea import).
- Produces: `startSession(el: EligibleField, send, onDetached?)` — signature otherwise unchanged; Tasks 7–8 pass `EligibleField`s in.

- [ ] **Step 1: Write the failing tests** (extend `session.test.ts` — read its harness first; it drives `startSession` with a fake `send`):

1. starting a session on a CE host sends `fieldConnected` with `fieldKind: 'contenteditable'`, `capabilities` from the CE adapter (`replace: 'best-effort'`; `mark` is `'none'` under happy-dom's missing registry — assert exactly that, it proves the feature gate), and the segment-map text.
2. `textChanged` flows after a DOM edit + input event (microtask flush).
3. `applyReplacement` round-trip against the CE adapter: ok:true echo with the new text.
4. click-to-select on a CE session: stub `document.getSelection` to a caret inside the field → `markingClicked` with the finding whose span covers the mapped offset; a caret outside → no message.
5. textarea sessions behave exactly as before (existing tests untouched and green).

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — the diff is contained:

```ts
import { createContentEditableAdapter } from '../../../frontend/src/simulator/contentEditableAdapter'
import { fieldKindOf, type EligibleField } from './detect'

export function startSession(
  el: EligibleField,
  send: (msg: Envelope<HostMessage>) => void,
  onDetached?: () => void,
): Session {
  const fieldKind = fieldKindOf(el)
  // Declared with the optional caret accessor so no cast is needed at the
  // call site (plan review N4): the CE adapter provides it, the textarea
  // adapter doesn't and never needs it.
  const adapter: FieldAdapter & { caretOffset?(): number | null } =
    el instanceof HTMLTextAreaElement
      ? createTextareaAdapter(el)
      : createContentEditableAdapter(el)
  ...
  function handleClick(): void {
    const pos = el instanceof HTMLTextAreaElement
      ? el.selectionStart ?? 0
      : adapter.caretOffset?.() ?? null
    if (pos === null) return
    const hitId = findingIdAt(currentFindings, selectedId, pos)
    ...
  }
  ...
  meta: { url: location.href, fieldKind },
```
Everything else (guards, detach/stop, MutationObserver-based self-detach — which works identically for a CE root leaving the document) stays verbatim.

- [ ] **Step 4: Run to verify PASS** (`rtk proxy npx vitest run src/session.test.ts`), then the whole extension suite: `rtk proxy npm test`, plus `rtk proxy npx oxlint`. (Build gate deferred to Task 8 — see Task 5's gate note.)

- [ ] **Step 5: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add clients/browser-extension/src/session.ts clients/browser-extension/src/session.test.ts
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(extension): contentEditable sessions (B43 C3)"
```

---

### Task 7: reacquire.ts generalization

**Files:**
- Modify: `clients/browser-extension/src/reacquire.ts`
- Test: `clients/browser-extension/src/reacquire.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `EligibleField`, `FieldKind`, `fieldKindOf`, `isEligibleField`.
- Produces: `computeFingerprint(el: EligibleField): Fingerprint` and `findFingerprintMatch(fingerprint): EligibleField | null`; `Fingerprint` gains a `fieldKind: FieldKind` member.

- [ ] **Step 1: Write the failing tests:**

1. a CE host with an id fingerprints as `kind: 'id'` and rebinds to a re-created same-id CE replacement.
2. a CE host with a unique `aria-label` (no id) fingerprints as `'aria'` and rebinds; selector matching works for `[contenteditable]` elements (they have no `name` in practice, but the attribute branch must query both kinds).
3. index fallback: two anonymous CE hosts → fingerprint `'formIndex'` indexes among SAME-KIND fields only; a replacement at the same index rebinds; a TEXTAREA appearing at that index does NOT (kind mismatch → null).
4. kind check is enforced on every branch: an id match whose element is now a textarea (same id, different kind) → null.
5. existing textarea fingerprint tests keep passing unchanged.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement.** Precise changes:

- `Fingerprint` gains `fieldKind: FieldKind`.
- `textareaScope(root)` becomes `fieldScope(root, kind)` — and the index semantics must NOT change for textareas nor become size-dependent (plan review SF8: reacquire runs exactly when a mid-render replacement may still measure 0×0, so an eligibility/size filter would make capture-time and rebind-time indices disagree). Precisely: for `'textarea'`, the list stays EXACTLY today's `querySelectorAll('textarea')` in document order, unfiltered; for `'contenteditable'`, `querySelectorAll('[contenteditable]:not([contenteditable="false"])')` narrowed to editing ROOTS (parent not editable — a structural check, NOT `isEligibleField`, so no size filter). The final eligibility gate stays where it already is: on the resolved candidate in `findFingerprintMatch`.
- attribute selectors generalize per kind: for `'textarea'` the selectors stay as-is; for `'contenteditable'` they become `[contenteditable][name="…"]` / `[contenteditable][aria-label="…"], [contenteditable][aria-labelledby="…"]`.
- `uniqueEligibleMatch` filters with `isEligibleField` (already kind-agnostic after Task 5) — add a `kind` parameter and require `fieldKindOf(match) === kind`.
- `computeFingerprint(el)`: `const fieldKind = fieldKindOf(el)` recorded in every return; the formIndex branch indexes within `fieldScope(form, fieldKind)`.
- `findFingerprintMatch`: every branch resolves with the fingerprint's own `fieldKind` (scope queries + `uniqueEligibleMatch(…, fieldKind)`), and the final gate becomes `if (!isEligibleField(candidate) || fieldKindOf(candidate) !== fingerprint.fieldKind) return null`.

- [ ] **Step 4: Run to verify PASS**, **Step 5: Mutation-verify** — remove the final kind gate; test 4 must fail; restore by re-editing.

- [ ] **Step 6: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add clients/browser-extension/src/reacquire.ts clients/browser-extension/src/reacquire.test.ts
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(extension): kind-aware field reacquisition (B43 C3)"
```

---

### Task 8: scout/affordance widening + enter/leave containment + marks.css

**Files:**
- Modify: `clients/browser-extension/src/scout.ts`
- Modify: `clients/browser-extension/src/affordance.ts` (type widening only — read it first; its logic is geometry-based and kind-agnostic)
- Modify: `clients/browser-extension/public/marks.css`
- Test: `clients/browser-extension/src/scout.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's `EligibleField`, `resolveEligibleField`; Task 6's widened `startSession`.
- Produces: nothing new — behavior parity for CE fields.

- [ ] **Step 1: Write the failing tests** (extend `scout.test.ts` per its harness):

1. `mouseover` on an INNER node of an eligible CE host shows the affordance anchored to the ROOT.
2. moving between two inner nodes of the same host (mouseout target=innerA, relatedTarget=innerB) schedules NO hide.
3. leaving the host from an inner node (mouseout target=inner, relatedTarget=body) schedules the hide.
4. the S1 regression stays fixed: a leave whose target is a DIFFERENT element than (and not inside) the shown field is ignored.
5. chip-click on a CE field starts a session (fieldConnected observed with `fieldKind: 'contenteditable'`).
6. startup one-shot: an autofocused CE host shows the affordance.

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement scout.ts.** Precise changes:

- All `HTMLTextAreaElement` state/parameter types (`sessionEl`, `shownEl`, `reconnect`, `beginReacquire`, `handleChipClick`, `handleDisconnectClick`, `showAffordance`) widen to `EligibleField`.
- `handleEnter`: `const field = resolveEligibleField(target)`; chip-host branch unchanged; `if (!field) return; cancelHide(); showAffordance(field)`.
- `handleLeave` becomes containment-based (this is the C3-critical piece — a CE field's leave events fire on inner nodes; identity against `shownEl` alone drops them). The S1 lesson HOLDS: no eligibility re-check on the leave path, only containment against `shownEl`:

```ts
function withinShown(t: EventTarget | null): boolean {
  return t instanceof Node && shownEl !== null && shownEl.contains(t) // contains(self) is true
}
function handleLeave(target: EventTarget | null, relatedTarget: EventTarget | null): void {
  if (isChipHost(target)) {
    if (withinShown(relatedTarget)) return
    scheduleHide()
    return
  }
  if (!withinShown(target)) return
  if (isChipHost(relatedTarget)) return
  if (withinShown(relatedTarget)) return // intra-field move between inner nodes
  scheduleHide()
}
```
- startup one-shot: `const startEl = resolveEligibleField(document.activeElement); if (startEl) showAffordance(startEl)`.
- `showAffordance` gets an early return (plan review SF12): inside a rich field every inner-node `mouseover` now resolves to the same root, and `affordance.showFor` unconditionally re-inserts + repositions the chip host — continuous DOM churn where a textarea hovered once. Early-return when already showing this exact field AND the chip host is still in the DOM, keeping the re-insert as the torn-out-host recovery path:
  ```ts
  function showAffordance(el: EligibleField): void {
    if (shownEl === el && affordance.host.isConnected) {
      // ensurePort() stays in BOTH paths (re-review item 1): after a port
      // death, handlePortDisconnect leaves shownEl set on purpose and the
      // next interaction's ensurePort() is the documented recovery route —
      // the early return must not skip it.
      ensurePort()
      renderChip()
      return
    }
    shownEl = el
    affordance.showFor(el)
    ensurePort()
    renderChip()
  }
  ```
  Add a test: two consecutive enters on inner nodes of the same shown host call `affordance.showFor` once (spy on it or count host re-insertions).

- [ ] **Step 4: affordance.ts** — widen its handler/`showFor` parameter types from `HTMLTextAreaElement` to `EligibleField` (import from `./detect`); no logic change. If any test stub constructs textareas explicitly, leave them — the widening is source-compatible.

- [ ] **Step 5: marks.css** — append (translucent, host-theme-friendly, same reasoning as the overlay palette; `::highlight()` accepts only color/background-color/text-decoration, hence underline instead of the overlay's outline):

```css
/* B43 C3: contentEditable markings via the CSS Custom Highlight API. These
 * names are registered only by this extension's ContentEditableAdapter
 * (fw-* Highlight registry entries); the rules are inert otherwise. Only
 * color / background-color / text-decoration are valid in ::highlight(). */
::highlight(fw-error) { background-color: rgba(248, 180, 180, 0.35); }
::highlight(fw-warning) { background-color: rgba(253, 230, 138, 0.35); }
::highlight(fw-suggestion) { background-color: rgba(191, 219, 254, 0.35); }
::highlight(fw-selected) { background-color: rgba(110, 86, 207, 0.25); text-decoration: underline solid rgba(110, 86, 207, 0.9); }
::highlight(fw-flash) { background-color: rgba(110, 86, 207, 0.45); }
```

- [ ] **Step 6: Run all extension gates**

Run: `cd /Users/markus/IdeaProjects/fabulous-writing/clients/browser-extension && rtk proxy npm test && rtk proxy npx oxlint && rtk proxy npm run build`
Expected: green, zero lint findings. This task RESTORES the full build gate deferred since Task 5 (`tsc --noEmit` inside `npm run build`) — a red build here is a Task 8 defect, not a deferral.

- [ ] **Step 7: Mutation-verify** — remove the `withinShown(relatedTarget)` intra-field return; test 2 must fail; restore by re-editing.

- [ ] **Step 8: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add clients/browser-extension/src/scout.ts clients/browser-extension/src/scout.test.ts clients/browser-extension/src/affordance.ts clients/browser-extension/public/marks.css
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "feat(extension): contentEditable affordance + highlight styles (B43 C3)"
```

---

### Task 9: e2e — fixture field + spec flow

**Files:**
- Modify: `clients/browser-extension/e2e/fixture.html`
- Modify: `clients/browser-extension/e2e/extension.spec.mjs`

**Interfaces:**
- Consumes: everything above, built (`npm run build` in BOTH `frontend/` and `clients/browser-extension/` — the runner preflights `frontend/dist/embed.html` and `dist/manifest.json`).

- [ ] **Step 1: fixture.html** — add below the textarea:

```html
<div id="cebox" contenteditable="true"
     style="width: 480px; min-height: 120px; border: 1px solid #888; padding: 8px; font: 14px/1.4 sans-serif;"></div>
```

- [ ] **Step 2: extension.spec.mjs** — read the existing textarea flow first and mirror it for `#cebox`: focus the div → affordance chip appears → chip click → panel/login (reuse the logged-in state the spec already establishes) → enter text with a known finding (the spec's existing idiom — `locator.fill(...)` works on contentEditable; `page.type` is deprecated) → wait for findings → assert highlight registration via
```js
const names = await page.evaluate(() => Array.from(CSS.highlights.keys()))
// expect names to include 'fw-error' (or the severity the seeded finding carries)
```
(valid cross-world: the plan review measured that a content script's Highlight registrations are visible to the main world's `CSS.highlights` in current Chromium and paint the manifest stylesheet's `::highlight` rules) → apply the first suggestion from the panel → assert the div's `textContent` contains the replacement → assert a fresh `textChanged`-driven re-check (findings update) → undo restores the pre-apply text (execCommand undo — REAL Chromium, the one path unit tests cannot cover): click/focus `#cebox` first (applyReplacement restores focus to the previously focused element), then `page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')` — plain Control+z silently does nothing on macOS. NO desync probe here (plan review SF10): the extension has no `textChanged`-suppression seam — a `page.evaluate` mutation triggers the adapter's observer → re-sync → the apply legitimately succeeds; the refuse paths are unit-tested in the frontend suite.

- [ ] **Step 3: Build both packages, run e2e**

Run (order matters):
```
cd /Users/markus/IdeaProjects/fabulous-writing/frontend && rtk proxy npm run build
cd /Users/markus/IdeaProjects/fabulous-writing/clients/browser-extension && rtk proxy npm run build && rtk proxy npm run e2e
```
Expected: PASS including the new CE flow. The runner owns ports 8100/8101 and aborts if occupied — if it aborts, report and stop; never free a port by killing its occupant.

- [ ] **Step 4: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add clients/browser-extension/e2e/fixture.html clients/browser-extension/e2e/extension.spec.mjs
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "test(extension): contentEditable e2e flow (B43 C3)"
```

---

### Task 10: docs + full-gate sweep

**Files:**
- Modify: `docs/frontend-architecture.md` (the embedding/simulator/adapter section — find it via `rtk proxy grep -n "adapter\|simulator\|embed" docs/frontend-architecture.md`)
- Modify: `docs/browser-extension.md` (plan review SF11 — it documents the eligibility rule, the adapter lift, the cross-package import paths, the reacquire fingerprint order, and the manual acceptance checklist; all five change in C3)
- Modify: `clients/browser-extension/public/manifest.json` — the user-visible `description` still says "text boxes (textareas)"; extend it to cover contentEditable fields (description string only; NOTHING else in the manifest — the `key` is untouchable)

- [ ] **Step 1:** Document, in the existing sections' voice: the segmentMap module and its newline model, the contentEditable adapter (highlight sink, change coalescing, best-effort replacement with post-verification), the per-host `::highlight` stylesheet rule, and the extension's `EligibleField` generalization. In `docs/browser-extension.md` also: update the eligibility rule text, the fingerprint order, the import-path list, add C3 rows to the manual acceptance checklist (incl. one cross-paragraph apply whose observed behavior is DOCUMENTED, not asserted — Chrome's insertText across a block boundary can rebalance blocks and legitimately echo `ok: false` + re-sync), and one sentence on the `fw-*` highlight-name namespace being document-global (a host page using the same names would interfere; accepted). A paragraph or two per item — match the surrounding density, no filler.
- [ ] **Step 2:** Full sweep, both packages, from their directories: frontend `rtk proxy npm test && rtk proxy npm run lint && rtk proxy npm run build && rtk proxy npm run check:embed`; extension `rtk proxy npm test && rtk proxy npx oxlint && rtk proxy npm run build`. Confirm `git -C /Users/markus/IdeaProjects/fabulous-writing status` shows a clean tree except intended changes, and `git -C /Users/markus/IdeaProjects/fabulous-writing diff main -- frontend/src/embed` is EMPTY (exit criterion, verified mechanically).
- [ ] **Step 3: Commit**

```bash
git -C /Users/markus/IdeaProjects/fabulous-writing add docs/frontend-architecture.md docs/browser-extension.md clients/browser-extension/public/manifest.json
git -C /Users/markus/IdeaProjects/fabulous-writing commit -m "docs: contentEditable adapter + segment map, extension docs/description (B43 C3)"
```

---

## Out of plan (recorded, not tasks)

- **PR + Copilot review + LOGBOOK:** after the plan completes, the branch goes up as a PR (finishing-a-development-branch flow); every Copilot thread gets replied to and resolved; the LOGBOOK entry lands as the LAST commit on the branch on the owner's cue; the owner merges (rebase-merge).
- **Manual acceptance (owner's session):** plain-CE benchmark on a real site (e.g. Gmail compose), one cross-paragraph apply with the observed behavior documented (a legitimate `ok: false` + re-sync is expected when Chrome rebalances blocks — plan review risk 1), and the framework smoke test on a Lexical editor (e.g. Reddit's composer); results recorded on issue #134 — the spec's acceptance section. The implementing session cannot drive the owner's browser; do not fake this.
- **Firefox/Safari (`::highlight` support ≥ FF 132 / Safari 17.2)** is C4/C5's concern.
