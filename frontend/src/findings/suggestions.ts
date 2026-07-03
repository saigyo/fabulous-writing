import type { Finding } from '../types'

/** Native suggestions win; otherwise LLM-fetched extras for this finding. */
export function effectiveSuggestions(
  finding: Finding,
  extras: Record<string, string[]>,
): string[] {
  return finding.suggestions.length > 0
    ? finding.suggestions
    : (extras[finding.id] ?? [])
}
