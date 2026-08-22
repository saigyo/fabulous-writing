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
