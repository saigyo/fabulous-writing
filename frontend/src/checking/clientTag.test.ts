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

  // Finding 11: an unknown value leaves the tag UNCHANGED, not forced back
  // to 'web' — a deliberate earlier tag (e.g. the embed's boot-time
  // setClientTag('embed')) must survive an unrecognized hello.
  it('leaves the tag unchanged for an unknown value', () => {
    setClientTag('browser-extension')
    setClientTag('unknown-client')
    expect(clientTag()).toBe('browser-extension')
  })

  it('still defaults to web when the very first call is an unknown value', () => {
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
