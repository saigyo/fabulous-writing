import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ownershipLabel } from './ownership'

describe('ownershipLabel', () => {
  it('appends the built-in marker to a global entry', () => {
    expect(ownershipLabel('Product docs', true, en)).toBe(`Product docs — ${en.globalBadge}`)
  })

  it('leaves a private entry unmarked', () => {
    expect(ownershipLabel('Product docs', false, en)).toBe('Product docs')
  })
})
