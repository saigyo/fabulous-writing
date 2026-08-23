import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SERVER_URL, getServerUrl, normalizeServerUrl, onServerUrlChanged, setServerUrl,
} from './settings'

describe('normalizeServerUrl', () => {
  it('returns an already-normalized https URL unchanged', () => {
    expect(normalizeServerUrl('https://fw.example')).toBe('https://fw.example')
  })

  it('strips a trailing slash', () => {
    expect(normalizeServerUrl('https://fw.example/')).toBe('https://fw.example')
  })

  it('accepts http with a port', () => {
    expect(normalizeServerUrl('http://localhost:8100')).toBe('http://localhost:8100')
  })

  it('rejects non-http(s) schemes', () => {
    expect(normalizeServerUrl('ftp://x')).toBeNull()
  })

  it('rejects a URL with a path', () => {
    expect(normalizeServerUrl('https://fw.example/app')).toBeNull()
  })

  it('rejects input without a scheme', () => {
    expect(normalizeServerUrl('fw.example')).toBeNull()
  })

  it('rejects the empty string', () => {
    expect(normalizeServerUrl('')).toBeNull()
  })
})

describe('getServerUrl / setServerUrl', () => {
  it('returns the default when storage is empty', async () => {
    expect(await getServerUrl()).toBe(DEFAULT_SERVER_URL)
  })

  it('returns the stored value once set', async () => {
    await setServerUrl('https://fw.example')
    expect(await getServerUrl()).toBe('https://fw.example')
  })
})

describe('onServerUrlChanged', () => {
  it('calls back with the new value when serverUrl changes', async () => {
    const cb = vi.fn()
    onServerUrlChanged(cb)
    await setServerUrl('https://fw.example')
    expect(cb).toHaveBeenCalledWith('https://fw.example')
  })
})
