import type { TrackedFinding } from '../editor/findings'

/**
 * Findings get fresh ids on every check. Two findings are "equivalent" when
 * they say the same thing (category + rule) about the same text at an
 * overlapping position — the basis for keeping selection and cached
 * suggestions alive across checks.
 */
export function findEquivalent(
  items: TrackedFinding[],
  previous: TrackedFinding | undefined,
): TrackedFinding | null {
  if (!previous) return null
  const candidates = items.filter(
    (item) =>
      item.finding.category === previous.finding.category &&
      item.finding.rule_id === previous.finding.rule_id &&
      item.finding.span.text === previous.finding.span.text &&
      item.from < previous.to &&
      previous.from < item.to,
  )
  candidates.sort(
    (a, b) => Math.abs(a.from - previous.from) - Math.abs(b.from - previous.from),
  )
  return candidates[0] ?? null
}

/** Map old finding ids to their equivalents in the new list (injective). */
export function mapEquivalentIds(
  oldItems: TrackedFinding[],
  newItems: TrackedFinding[],
): Record<string, string> {
  const map: Record<string, string> = {}
  const taken = new Set<string>()
  for (const previous of oldItems) {
    const available = newItems.filter((item) => !taken.has(item.finding.id))
    const match = findEquivalent(available, previous)
    if (match) {
      map[previous.finding.id] = match.finding.id
      taken.add(match.finding.id)
    }
  }
  return map
}
