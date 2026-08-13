// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRefreshToken,
  clearToken,
  clearTokenExpiresAt,
  deleteLegacyBlob,
  prefsKey,
  readPrefs,
  readRefreshToken,
  readToken,
  readTokenExpiresAt,
  writePrefs,
  writeRefreshToken,
  writeToken,
  writeTokenExpiresAt,
  type Prefs,
} from './prefsStorage'

beforeEach(() => {
  localStorage.clear()
})

const prefs: Prefs = {
  uiLocale: 'de',
  lastProfileByLanguage: { en: 3 },
  rulesCollapsed: ['style'],
  currentDocId: 7,
  docSidebarCollapsed: true,
  docFoldersCollapsed: [1, 2],
}

describe('token accessors', () => {
  it('round-trips under the token key and clears', () => {
    expect(readToken()).toBeNull()
    writeToken('tok')
    expect(localStorage.getItem('fabulous-writing-token')).toBe('tok')
    expect(readToken()).toBe('tok')
    clearToken()
    expect(readToken()).toBeNull()
  })
})

describe('refresh-token accessors', () => {
  it('round-trips under the refresh-token key and clears', () => {
    expect(readRefreshToken()).toBeNull()
    writeRefreshToken('rt')
    expect(localStorage.getItem('fabulous-writing-refresh-token')).toBe('rt')
    expect(readRefreshToken()).toBe('rt')
    clearRefreshToken()
    expect(readRefreshToken()).toBeNull()
  })

  it('writing null removes the key rather than storing the string "null"', () => {
    writeRefreshToken('rt')
    writeRefreshToken(null)
    expect(localStorage.getItem('fabulous-writing-refresh-token')).toBeNull()
    expect(readRefreshToken()).toBeNull()
  })
})

describe('token-expiry accessors', () => {
  it('round-trips as a decimal string under the expiry key and clears', () => {
    expect(readTokenExpiresAt()).toBeNull()
    writeTokenExpiresAt(1_900_000_000)
    expect(localStorage.getItem('fabulous-writing-token-expires')).toBe('1900000000')
    expect(readTokenExpiresAt()).toBe(1_900_000_000)
    clearTokenExpiresAt()
    expect(readTokenExpiresAt()).toBeNull()
  })

  it('writing null removes the key rather than storing the string "null"', () => {
    writeTokenExpiresAt(1_900_000_000)
    writeTokenExpiresAt(null)
    expect(localStorage.getItem('fabulous-writing-token-expires')).toBeNull()
    expect(readTokenExpiresAt()).toBeNull()
  })

  it('treats a corrupt (non-numeric) stored value as absent', () => {
    localStorage.setItem('fabulous-writing-token-expires', 'not-a-number')
    expect(readTokenExpiresAt()).toBeNull()
  })

  it('treats a non-finite stored value (Infinity/-Infinity) as absent', () => {
    // "Infinity" parses to a real, non-NaN number -- Number.isNaN alone lets
    // it through, and scheduleRefresh's delay computation would then clamp
    // an infinite deadline to 0, producing a degenerate refresh loop
    // (Copilot round 3) instead of being treated as corrupt storage.
    localStorage.setItem('fabulous-writing-token-expires', 'Infinity')
    expect(readTokenExpiresAt()).toBeNull()
    localStorage.setItem('fabulous-writing-token-expires', '-Infinity')
    expect(readTokenExpiresAt()).toBeNull()
  })
})

describe('readPrefs / writePrefs', () => {
  it('round-trips a blob in the zustand-persist envelope', () => {
    writePrefs(1, prefs)
    expect(JSON.parse(localStorage.getItem(prefsKey(1))!)).toEqual({
      state: prefs,
      version: 2,
    })
    expect(readPrefs(1)).toEqual(prefs)
  })

  it('keeps namespaces separate per user id', () => {
    writePrefs(1, prefs)
    expect(readPrefs(2)).toBeNull()
  })

  it('returns null for a missing blob', () => {
    expect(readPrefs(1)).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    localStorage.setItem(prefsKey(1), '{not json')
    expect(readPrefs(1)).toBeNull()
  })

  it('returns null for a wrong version', () => {
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({ state: prefs, version: 3 }),
    )
    expect(readPrefs(1)).toBeNull()
  })

  it('returns null for an envelope without a state object', () => {
    localStorage.setItem(prefsKey(1), JSON.stringify({ version: 2 }))
    expect(readPrefs(1)).toBeNull()
  })

  it('drops unknown keys instead of smuggling them into the store', () => {
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({ state: { uiLocale: 'de', token: 'evil' }, version: 2 }),
    )
    expect(readPrefs(1)).toEqual({ uiLocale: 'de' })
  })

  it('drops malformed field values instead of loading them (storage is user-editable)', () => {
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({
        state: {
          uiLocale: 'xx',
          lastProfileByLanguage: { en: 'three' },
          rulesCollapsed: 'style',
          currentDocId: '7',
          docSidebarCollapsed: 1,
          docFoldersCollapsed: [1, null],
        },
        version: 2,
      }),
    )
    expect(readPrefs(1)).toEqual({})
  })

  it('keeps valid fields while dropping invalid siblings', () => {
    localStorage.setItem(
      prefsKey(1),
      JSON.stringify({
        state: { uiLocale: 'de', docFoldersCollapsed: null },
        version: 2,
      }),
    )
    expect(readPrefs(1)).toEqual({ uiLocale: 'de' })
  })
})

describe('storage failures (quota, privacy mode)', () => {
  // If spying on Storage.prototype does not intercept happy-dom's
  // localStorage, fall back to vi.stubGlobal('localStorage', throwingStub)
  // — the assertions stay the same.
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads fall back to null when getItem throws', () => {
    const throwingStub = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      clear: () => {},
    }
    vi.stubGlobal('localStorage', throwingStub)
    expect(readToken()).toBeNull()
    expect(readPrefs(1)).toBeNull()
    expect(readRefreshToken()).toBeNull()
    expect(readTokenExpiresAt()).toBeNull()
  })

  it('writes and removals never throw when the underlying storage throws', () => {
    const throwingStub = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
      clear: () => {},
    }
    vi.stubGlobal('localStorage', throwingStub)
    expect(() => writeToken('tok')).not.toThrow()
    expect(() => writePrefs(1, prefs)).not.toThrow()
    expect(() => clearToken()).not.toThrow()
    expect(() => deleteLegacyBlob()).not.toThrow()
    expect(() => writeRefreshToken('rt')).not.toThrow()
    expect(() => writeRefreshToken(null)).not.toThrow()
    expect(() => clearRefreshToken()).not.toThrow()
    expect(() => writeTokenExpiresAt(1_900_000_000)).not.toThrow()
    expect(() => writeTokenExpiresAt(null)).not.toThrow()
    expect(() => clearTokenExpiresAt()).not.toThrow()
  })
})
