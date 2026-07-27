import type { MeResponse } from '../api/client'
import { llmDisabled } from '../auth/policy'
import type { Messages } from '../i18n/messages'

/**
 * One home for skip-code copy (spec §7.2's shared vocabulary): the sidebar
 * notes and the suggestion/rewrite errors must never drift apart. The
 * numbers come from /me — the report itself carries only the code.
 */
export function skipNoticeText(
  code: string | null | undefined,
  user: MeResponse | null,
  m: Messages,
): string | null {
  switch (code) {
    case 'quota_exhausted':
      return m.llmQuotaExhausted(user?.usage.limit ?? 0)
    case 'document_too_large':
      return m.llmDocumentTooLarge(user?.limits.max_llm_document_chars ?? 0)
    case 'llm_unavailable':
      return llmDisabled(user) ? m.llmNotIncluded : m.llmSkippedServer
    default:
      return null
  }
}
