import type { Messages } from '../i18n/messages'

/** Message shown when the LLM answered but no candidate survived local vetting. */
export function noReliableSuggestionMessage(
  suggestions: string[],
  rejected: number,
  messages: Messages,
): string | null {
  if (suggestions.length > 0 || rejected === 0) return null
  return messages.noReliableSuggestion(rejected)
}
