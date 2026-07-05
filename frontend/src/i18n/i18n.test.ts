import { describe, expect, test } from 'vitest'
import { catalogs, detectLocale, interpolate } from './index'
import { LOCALES } from './messages'
import { en } from './en'

describe('detectLocale', () => {
  test('matches an exact supported locale', () => {
    expect(detectLocale(['de'])).toBe('de')
  })

  test('matches the primary subtag of a region variant', () => {
    expect(detectLocale(['de-AT'])).toBe('de')
    expect(detectLocale(['zh-Hans-CN'])).toBe('zh')
  })

  test('walks the preference list until a supported locale', () => {
    expect(detectLocale(['da', 'sv', 'fr-CH'])).toBe('fr')
  })

  test('falls back to English', () => {
    expect(detectLocale(['da', 'sv'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })

  test('is case-insensitive', () => {
    expect(detectLocale(['JA-jp'])).toBe('ja')
  })
})

describe('catalogs', () => {
  test('every supported locale has a catalog', () => {
    for (const locale of LOCALES) {
      expect(catalogs[locale], locale).toBeDefined()
    }
  })

  test('every catalog has exactly the keys of the English one', () => {
    const reference = Object.keys(en).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), locale).toEqual(reference)
    }
  })

  test('functions in English are functions everywhere', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(en)) {
        expect(typeof catalogs[locale][key as keyof typeof en], `${locale}.${key}`).toBe(
          typeof value,
        )
      }
    }
  })

  test('pluralization: English and German inflect, Japanese counts', () => {
    expect(en.severityCount('error', 1)).toBe('1 error')
    expect(en.severityCount('error', 3)).toBe('3 errors')
    expect(catalogs.de.severityCount('error', 1)).toBe('1 Fehler')
    expect(catalogs.de.severityCount('warning', 2)).toBe('2 Warnungen')
    expect(catalogs.ja.severityCount('error', 3)).toBe('エラー 3件')
  })

  test('source group chips label rule-based vs LLM findings', () => {
    expect(en.sourceGroupCount('rule', 12)).toBe('12 rule-based')
    expect(en.sourceGroupCount('llm', 1)).toBe('1 LLM')
    expect(catalogs.de.sourceGroupCount('rule', 2)).toBe('2 regelbasiert')
    expect(catalogs.ja.sourceGroupCount('llm', 3)).toBe('LLM 3件')
  })

  test('vetting message includes the candidate count', () => {
    expect(en.noReliableSuggestion(1)).toContain('1 candidate')
    expect(en.noReliableSuggestion(3)).toContain('3 candidates')
    expect(catalogs.de.noReliableSuggestion(3)).toContain('3')
  })

  test('llm status label embeds elapsed time and token count', () => {
    expect(en.llmChecking('12s', 1200)).toBe('LLM checking… (12s · ↓ 1,200 tokens)')
    expect(en.llmChecking('5s', null)).toBe('LLM checking… (5s)')
    expect(catalogs.de.llmChecking('12s', 1200)).toContain('1.200')
  })

  test('profile messages exist', () => {
    expect(en.profile).toBe('Profile')
    expect(en.domainsSelected(2)).toBe('2 domains')
    expect(catalogs.de.domainsSelected(2)).toBe('2 Domänen')
  })
})

describe('interpolate', () => {
  test('replaces placeholders with the given nodes in template order', () => {
    expect(interpolate('rules live in {path} — reload via {endpoint}', {
      path: 'PATH',
      endpoint: 'END',
    })).toEqual(['rules live in ', 'PATH', ' — reload via ', 'END'])
  })

  test('keeps unknown placeholders verbatim', () => {
    expect(interpolate('hello {who}', {})).toEqual(['hello ', '{who}'])
  })
})
