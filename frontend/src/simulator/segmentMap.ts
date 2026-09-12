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
