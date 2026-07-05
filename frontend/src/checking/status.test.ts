import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { llmStatusLabel } from './status'

describe('llmStatusLabel', () => {
  it('shows elapsed seconds', () => {
    expect(llmStatusLabel(4_200, null, en)).toBe('LLM checking… (4s)')
  })

  it('adds the token counter once tokens arrive', () => {
    expect(llmStatusLabel(12_600, 340, en)).toBe('LLM checking… (12s · ↓ 340 tokens)')
  })

  it('formats minutes and seconds', () => {
    expect(llmStatusLabel(83_000, 1200, en)).toBe('LLM checking… (1m 23s · ↓ 1,200 tokens)')
  })
})
