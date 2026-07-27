import type { Messages } from '../i18n/messages'
import type { LlmSelectionInfo } from '../types'

/** Human label for one side of an effective_llm report: the quality tier's
 * localized name when the selection is tier-routed, else the pinned pair. */
export function effectiveLabel(sel: LlmSelectionInfo, m: Messages): string {
  if (sel.tier) return m.tierName(sel.tier)
  if (sel.provider) return sel.model ? `${sel.model} (${sel.provider})` : sel.provider
  return ''
}
