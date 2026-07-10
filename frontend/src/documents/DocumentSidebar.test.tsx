import { describe, expect, it } from 'vitest'
import { relativeTime } from './DocumentSidebar'

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
