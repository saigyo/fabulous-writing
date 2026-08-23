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

  // F4 (final review): pay.host.kind/version must both be strings, not
  // merely present as an object.
  it('rejects a hello whose host.kind or host.version is missing or not a string', () => {
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'hello',
        payload: { host: { version: '0.0.1' } },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'hello',
        payload: { host: { kind: 'simulator' } },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'hello',
        payload: { host: { kind: 1, version: '0.0.1' } },
      }),
    ).toBeNull()
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

  // Copilot round 1: meta.url/meta.fieldKind must both be strings.
  it('rejects fieldConnected with missing or malformed meta', () => {
    const base = {
      fw: PROTOCOL_VERSION,
      type: 'fieldConnected',
      payload: { fieldId: 'f1', text: 't', capabilities: caps },
    }
    expect(parseHostMessage(base)).toBeNull() // no meta at all
    expect(
      parseHostMessage({
        ...base,
        payload: { ...base.payload, meta: { fieldKind: 'textarea' } },
      }),
    ).toBeNull() // missing url
    expect(
      parseHostMessage({
        ...base,
        payload: { ...base.payload, meta: { url: 'https://host.example', fieldKind: 1 } },
      }),
    ).toBeNull() // fieldKind not a string
    expect(
      parseHostMessage({
        ...base,
        payload: { ...base.payload, meta: { url: 'https://host.example', fieldKind: 'textarea' } },
      }),
    ).not.toBeNull()
  })

  // Copilot round 1: markingClicked requires a string id, validated
  // separately from fieldDisconnected's fieldId-only shape.
  it('rejects markingClicked with a missing or non-string id', () => {
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'markingClicked', payload: { fieldId: 'f1' },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'markingClicked', payload: { fieldId: 'f1', id: 1 },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'markingClicked', payload: { fieldId: 'f1', id: 'finding-1' },
      }),
    ).not.toBeNull()
  })

  // Copilot round 1: replaceResult.payload.fieldId is the shim's
  // stale-field guard — reject at the parser when it's missing.
  it('rejects replaceResult without a string payload.fieldId', () => {
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'replaceResult',
        requestId: 'r1',
        payload: { ok: true, text: 'hi' },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'replaceResult',
        requestId: 'r1',
        payload: { fieldId: 'f1', ok: true, text: 'hi' },
      }),
    ).not.toBeNull()
  })

  // Finding 9: an empty-string fieldId passes typeof === 'string' but can
  // never legitimately name a connected field — reject it at the parser for
  // every message shape that carries one, same as a missing/non-string one.
  it('rejects an empty-string fieldId on every message shape that carries one', () => {
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'fieldConnected',
        payload: { fieldId: '', text: 't', capabilities: caps, meta: { url: '', fieldKind: '' } },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'textChanged', payload: { fieldId: '', text: 't' },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION,
        type: 'replaceResult',
        requestId: 'r1',
        payload: { fieldId: '', ok: true, text: 'hi' },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'markingClicked', payload: { fieldId: '', id: 'finding-1' },
      }),
    ).toBeNull()
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'fieldDisconnected', payload: { fieldId: '' },
      }),
    ).toBeNull()
  })

  // Finding 9: markingClicked's id is a finding id, not a field id, but the
  // same emptiness hazard applies — an empty string is a string, not a real
  // finding id.
  it('rejects markingClicked with an empty-string id', () => {
    expect(
      parseHostMessage({
        fw: PROTOCOL_VERSION, type: 'markingClicked', payload: { fieldId: 'f1', id: '' },
      }),
    ).toBeNull()
  })
})
