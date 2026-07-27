import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import type { LlmSelectionInfo } from '../types'
import { effectiveLabel } from './effectiveLabel'

describe('effectiveLabel', () => {
  it('labels a tier selection with the localized tier name', () => {
    const sel: LlmSelectionInfo = { tier: 'cheap', provider: null, model: null }
    expect(effectiveLabel(sel, en)).toBe(en.tierName('cheap'))
  })

  it('labels a pinned selection as "model (provider)"', () => {
    const sel: LlmSelectionInfo = {
      tier: null,
      provider: 'claude',
      model: 'claude-sonnet-5',
    }
    expect(effectiveLabel(sel, en)).toBe('claude-sonnet-5 (claude)')
  })

  it('labels an all-null selection as the empty string', () => {
    const sel: LlmSelectionInfo = { tier: null, provider: null, model: null }
    expect(effectiveLabel(sel, en)).toBe('')
  })
})
