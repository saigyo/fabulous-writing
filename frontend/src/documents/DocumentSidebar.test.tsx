import { describe, expect, it } from 'vitest'
import { absoluteTime, groupDocuments, relativeTime } from './DocumentSidebar'

describe('absoluteTime', () => {
  it('renders a localized date and time', () => {
    const iso = '2026-07-11T16:42:00+00:00'
    const en = absoluteTime(iso, 'en')
    const de = absoluteTime(iso, 'de')
    // Locale-dependent rendering; assert the load-bearing parts only:
    // en medium style is "Jul 11, 2026", de medium style is "11.07.2026".
    expect(en).toContain('2026')
    expect(en).toMatch(/Jul/)
    expect(de).toContain('2026')
    expect(de).toContain('11.07.')
  })

  it('returns an empty string for unparseable input', () => {
    expect(absoluteTime('', 'en')).toBe('')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-07-10T12:00:00+00:00')
  it('renders minutes, hours and days in the given locale', () => {
    expect(relativeTime('2026-07-10T11:58:00+00:00', 'en', now)).toMatch(/minute/)
    expect(relativeTime('2026-07-10T09:00:00+00:00', 'en', now)).toMatch(/hour/)
    expect(relativeTime('2026-07-07T12:00:00+00:00', 'de', now)).toMatch(/Tag/)
  })
  it('clamps future timestamps (clock skew) to "now"', () => {
    expect(relativeTime('2026-07-10T12:00:30+00:00', 'en', now)).toBe(
      relativeTime('2026-07-10T12:00:00+00:00', 'en', now),
    )
  })
})

describe('groupDocuments', () => {
  const folders = [
    { id: 1, name: 'Blog', created_at: '' },
    { id: 2, name: 'Work', created_at: '' },
  ]
  const docs = [
    { id: 10, name: 'A', language: 'en', folder_id: 2, updated_at: '' },
    { id: 11, name: 'B', language: 'en', folder_id: null, updated_at: '' },
    { id: 12, name: 'C', language: 'en', folder_id: 1, updated_at: '' },
    { id: 13, name: 'D', language: 'en', folder_id: 99, updated_at: '' },
  ] as never[]

  it('groups by folder, keeps recency order, orphans go ungrouped', () => {
    const grouped = groupDocuments(docs, folders)
    expect(grouped.byFolder.get(1)?.map((d) => d.id)).toEqual([12])
    expect(grouped.byFolder.get(2)?.map((d) => d.id)).toEqual([10])
    // folder_id pointing at a vanished folder falls back to ungrouped.
    expect(grouped.ungrouped.map((d) => d.id)).toEqual([11, 13])
  })

  it('empty folders still appear (just created)', () => {
    const grouped = groupDocuments([], folders)
    expect(grouped.byFolder.get(1)).toEqual([])
    expect(grouped.byFolder.get(2)).toEqual([])
  })
})
