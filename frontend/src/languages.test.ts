import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { FALLBACK_LANGUAGES, languageLabel, languageName } from './languages'

describe('languageName', () => {
  it('resolves a code to its endonym', () => {
    expect(languageName('ja', FALLBACK_LANGUAGES)).toBe('日本語')
    expect(languageName('de', FALLBACK_LANGUAGES)).toBe('Deutsch')
  })

  it('falls back to the code when unknown', () => {
    expect(languageName('xx', FALLBACK_LANGUAGES)).toBe('xx')
    expect(languageName('en', [])).toBe('en')
  })
})

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
