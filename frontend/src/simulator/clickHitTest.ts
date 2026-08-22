// Click hit-test for the mirror overlay's markings (spec: B43, C1 embed
// surface, Task 7 / Copilot round 3). Mirrors editor/findings.ts's
// findingIdAt: a click hits every finding whose span covers the caret
// position, and the SMALLEST of those wins — not source order — so a
// whole-sentence finding never shadows a point finding nested inside it.
// When the currently selected finding is among the hits, the next-larger
// one is chosen instead, so repeated clicks at the same spot cycle outward
// through the whole stack.
import type { MarkingSpan } from '../embed/protocol'

export function findingIdAt(
  findings: MarkingSpan[],
  selectedId: string | null,
  pos: number,
): string | null {
  const hits = findings
    .filter((f) => f.from <= pos && pos <= f.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from))
  if (hits.length === 0) return null
  const current = hits.findIndex((f) => f.id === selectedId)
  return hits[(current + 1) % hits.length].id
}
