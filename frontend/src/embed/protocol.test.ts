import { describe, expect, it } from 'vitest'
import { parseHostMessage, PROTOCOL_VERSION } from './protocol'

const caps = { mark: 'overlay', replace: 'reliable' }

describe('parseHostMessage', () => {
  it('accepts a well-formed hello', () => {
    const msg = parseHostMessage({
      fw: PROTOCOL_VERSION,
      type: 'hello',
      payload: { host: { kind: 'simulator', version: '0.0.1' } },
    })
    expect(msg?.type).toBe('hello')
  })

  it('rejects non-objects, missing fw, unknown types, wrong version', () => {
    expect(parseHostMessage(null)).toBeNull()
    expect(parseHostMessage('x')).toBeNull()
    expect(parseHostMessage({ type: 'hello', payload: {} })).toBeNull()
    expect(parseHostMessage({ fw: PROTOCOL_VERSION, type: 'nope', payload: {} })).toBeNull()
    expect(parseHostMessage({ fw: PROTOCOL_VERSION + 1, type: 'hello', payload: {} })).toBeNull()
  })

  it('rejects textChanged without string text', () => {
    expect(
      parseHostMessage({ fw: PROTOCOL_VERSION, type: 'textChanged', payload: { fieldId: 'f1' } }),
    ).toBeNull()
  })

  it('rejects fieldConnected with missing or malformed capabilities', () => {
    const base = { fw: PROTOCOL_VERSION, type: 'fieldConnected' }
    expect(
      parseHostMessage({ ...base, payload: { fieldId: 'f1', text: 't', meta: { url: '', fieldKind: '' } } }),
    ).toBeNull()
    expect(
      parseHostMessage({
        ...base,
        payload: { fieldId: 'f1', text: 't', capabilities: { mark: 'sparkly', replace: 'reliable' }, meta: { url: '', fieldKind: '' } },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        ...base,
        payload: { fieldId: 'f1', text: 't', capabilities: caps, meta: { url: '', fieldKind: '' } },
      }),
    ).not.toBeNull()
  })
})
