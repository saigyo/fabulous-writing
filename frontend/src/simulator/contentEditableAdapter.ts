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
// offsetAt is not imported here: Task 2 leaves caretOffset() as a stub (it
// will need offsetAt once Task 3 implements it) — importing it now would be
// an unused import, an error under this project's noUnusedLocals (tsc -b)
// and a lint warning (oxlint), same category of deviation the brief already
// flags for SEVERITIES above.
import { buildSegmentMap, rangeFor, type SegmentMap } from './segmentMap'

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
