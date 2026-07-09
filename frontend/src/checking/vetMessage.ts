import type { HeldBackSuggestion } from '../api/client'
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

/** One-line reason shown under a revealed held-back candidate. */
export function heldBackReason(
  candidate: HeldBackSuggestion,
  messages: Messages,
): string {
  return candidate.reason_kind === 'rules'
    ? messages.heldBackRules(candidate.rule_ids.join(', '))
    : messages.heldBackSpelling(candidate.words.join(', '))
}
