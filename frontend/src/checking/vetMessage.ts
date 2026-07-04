/** Message shown when the LLM answered but no candidate survived local vetting. */
export function noReliableSuggestionMessage(
  suggestions: string[],
  rejected: number,
): string | null {
  if (suggestions.length > 0 || rejected === 0) return null
  const candidates = rejected === 1 ? '1 candidate' : `${rejected} candidates`
  return `No reliable suggestion — ${candidates} failed local checks.`
}
