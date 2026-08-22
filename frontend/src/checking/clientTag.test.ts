import { describe, expect, it, beforeEach } from 'vitest'
import { clientTag, setClientTag } from './clientTag'

describe('clientTag', () => {
  beforeEach(() => {
    // Reset to default before each test
    setClientTag('web')
  })

  it('defaults to web', () => {
    expect(clientTag()).toBe('web')
  })

  it('returns the tag after setClientTag is called with a valid value', () => {
    setClientTag('browser-extension')
    expect(clientTag()).toBe('browser-extension')
  })

  it('falls back to web for unknown values', () => {
    setClientTag('unknown-client')
    expect(clientTag()).toBe('web')
  })

  it('accepts all valid client types', () => {
    const validTypes = ['web', 'embed', 'browser-extension', 'vscode', 'jetbrains', 'simulator']
    for (const type of validTypes) {
      setClientTag(type)
      expect(clientTag()).toBe(type)
    }
  })
})
