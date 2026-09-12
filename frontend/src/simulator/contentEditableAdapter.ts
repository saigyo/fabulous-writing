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
import { buildSegmentMap, offsetAt, rangeFor, resolvePoint, type SegmentMap } from './segmentMap'

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
      // message later.) Comparing the WHOLE extraction against the exact
      // expected result is required, not just the inserted slice + total
      // length (Copilot round 2, F1): a synchronous rewrite that changes a
      // DIFFERENT character while preserving both of those (e.g. 'abc' ->
      // replace 'b' with 'X' while the host also flips 'c' to 'Y') used to
      // report ok:true for a wrong result. The full compare subsumes the
      // old slice term AND the old length-delta term — the latter was the
      // only check that caught an empty insert whose deletion the host
      // restored (test case 10), and a whole-text compare catches that too.
      // One accepted consequence (risk-1, unchanged): a cross-block
      // execCommand apply that rebalances block structure changes the
      // synthetic-newline layout even when the visible characters end up
      // right, so the full compare reports ok:false there as well.
      map = buildSegmentMap(root)
      const ok = map.text === text.slice(0, from) + insert + text.slice(to)
      root.scrollTop = scrollTop
      root.scrollLeft = scrollLeft
      if (prev instanceof HTMLElement && prev !== root) prev.focus({ preventScroll: true })
      return { ok, text: map.text }
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
