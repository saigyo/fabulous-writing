import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { FALLBACK_LANGUAGES, languageLabel } from './languages'

describe('languageLabel', () => {
  it('shows the plain name when NLP is available', () => {
    expect(
      languageLabel({
        code: 'en',
        name: 'English',
        nlp_available: true,
        model: 'en_core_web_sm',
      }, en),
    ).toBe('English')
  })

  it('appends a basic-checks hint when NLP is unavailable', () => {
    expect(
      languageLabel({
        code: 'fr',
        name: 'Français',
        nlp_available: false,
        model: 'fr_core_news_sm',
      }, en),
    ).toBe('Français (basic checks only)')
  })
})

describe('FALLBACK_LANGUAGES', () => {
  it('covers all seven language codes', () => {
    expect(FALLBACK_LANGUAGES.map((l) => l.code)).toEqual([
      'en',
      'de',
      'fr',
      'es',
      'it',
      'ja',
      'zh',
    ])
  })
})
