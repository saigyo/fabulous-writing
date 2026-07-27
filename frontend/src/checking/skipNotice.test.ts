import { describe, expect, it } from 'vitest'
import { en as messages } from '../i18n/en'
import { skipNoticeText } from './skipNotice'

const user = (over: object) => ({
  id: 1, email: 'u@example.com', display_name: null, tier: 'basic',
  is_admin: false,
  policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
  usage: { used_today: 20, limit: 20 },
  limits: { max_document_chars: 200000, max_llm_document_chars: 20000,
            concurrent_llm_runs: 3 },
  allow_additional_admins: false,
  ...over,
})

describe('skipNoticeText', () => {
  it('maps quota_exhausted with the caller limit', () => {
    expect(skipNoticeText('quota_exhausted', user({}), messages)).toBe(
      messages.llmQuotaExhausted(20),
    )
  })
  it('maps document_too_large with the LLM char limit', () => {
    expect(skipNoticeText('document_too_large', user({}), messages)).toBe(
      messages.llmDocumentTooLarge(20000),
    )
  })
  it('splits llm_unavailable into floor vs server copy', () => {
    const floored = user({
      policy: { llm: { tiers: [], providers: [], models: null }, features: [] },
    })
    expect(skipNoticeText('llm_unavailable', floored, messages)).toBe(
      messages.llmNotIncluded,
    )
    expect(skipNoticeText('llm_unavailable', user({}), messages)).toBe(
      messages.llmSkippedServer,
    )
  })
  it('returns null for no skip and unknown codes', () => {
    expect(skipNoticeText(null, user({}), messages)).toBeNull()
    expect(skipNoticeText('mystery', user({}), messages)).toBeNull()
  })
})
