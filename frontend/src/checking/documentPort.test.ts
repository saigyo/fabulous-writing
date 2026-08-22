import { afterEach, describe, expect, it } from 'vitest'
import { getDocumentPort, setDocumentPort, type DocumentPort } from './documentPort'

afterEach(() => {
  setDocumentPort(null)
})

describe('documentPort default (null object)', () => {
  it('hasDocument() is false — the load-bearing guard for autosave data loss', () => {
    expect(getDocumentPort().hasDocument()).toBe(false)
  })

  it('getText() is an empty string', () => {
    expect(getDocumentPort().getText()).toBe('')
  })

  it('currentFinding() and serverSpan() are null', () => {
    expect(getDocumentPort().currentFinding('f1')).toBeNull()
    expect(getDocumentPort().serverSpan('f1')).toBeNull()
  })

  it('setDocument(), mergeFindings() and selectFinding() no-op without throwing', () => {
    expect(() => getDocumentPort().setDocument('text', [])).not.toThrow()
    expect(() => getDocumentPort().mergeFindings(['rule'], [])).not.toThrow()
    expect(() => getDocumentPort().selectFinding('f1')).not.toThrow()
  })

  it('applySuggestion() and applyRewrite() resolve not-found', async () => {
    await expect(getDocumentPort().applySuggestion('f1', 'x')).resolves.toBe('not-found')
    await expect(getDocumentPort().applyRewrite('f1', 'a', 'b')).resolves.toBe('not-found')
  })
})

describe('setDocumentPort', () => {
  it('returns the registered instance after setDocumentPort(fake)', () => {
    const fake: DocumentPort = {
      hasDocument: () => true,
      getText: () => 'fake text',
      setDocument: () => {},
      currentFinding: () => null,
      serverSpan: () => null,
      mergeFindings: () => {},
      selectFinding: () => {},
      applySuggestion: () => Promise.resolve('ok'),
      applyRewrite: () => Promise.resolve('ok'),
    }
    setDocumentPort(fake)
    expect(getDocumentPort()).toBe(fake)
    expect(getDocumentPort().getText()).toBe('fake text')
  })

  it('setDocumentPort(null) restores the null object', () => {
    const fake: DocumentPort = {
      hasDocument: () => true,
      getText: () => 'fake text',
      setDocument: () => {},
      currentFinding: () => null,
      serverSpan: () => null,
      mergeFindings: () => {},
      selectFinding: () => {},
      applySuggestion: () => Promise.resolve('ok'),
      applyRewrite: () => Promise.resolve('ok'),
    }
    setDocumentPort(fake)
    setDocumentPort(null)
    expect(getDocumentPort().hasDocument()).toBe(false)
    expect(getDocumentPort().getText()).toBe('')
  })
})
