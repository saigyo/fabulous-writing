import { describe, expect, it } from 'vitest'
import { envelope, type ReadyMessage } from '../../../frontend/src/embed/protocol'
import { HOST_KIND, parsePortMessage } from './messages'

const readyEnvelope = envelope<ReadyMessage>({
  type: 'ready',
  payload: { protocolVersion: 1, features: [] },
})

const helloEnvelope = {
  fw: 1,
  type: 'hello',
  payload: { host: { kind: HOST_KIND, version: '0.1.0' } },
}

describe('parsePortMessage', () => {
  it('accepts a relay wrapping a valid host envelope', () => {
    expect(parsePortMessage({ relay: helloEnvelope })).toEqual({ relay: helloEnvelope })
  })

  it('accepts a relay wrapping a valid embed envelope', () => {
    expect(parsePortMessage({ relay: readyEnvelope })).toEqual({ relay: readyEnvelope })
  })

  it('accepts an openPanel ctl message', () => {
    expect(parsePortMessage({ ctl: { kind: 'openPanel' } })).toEqual({ ctl: { kind: 'openPanel' } })
  })

  it('accepts a panelHello ctl message', () => {
    const msg = { kind: 'panelHello', windowId: 7 }
    expect(parsePortMessage({ ctl: msg })).toEqual({ ctl: msg })
  })

  it('accepts an embedReady ctl message', () => {
    const msg = { kind: 'embedReady', ready: true }
    expect(parsePortMessage({ ctl: msg })).toEqual({ ctl: msg })
  })

  it('accepts a detach ctl message', () => {
    const msg = { kind: 'detach', fieldId: 'f1' }
    expect(parsePortMessage({ ctl: msg })).toEqual({ ctl: msg })
  })

  it('accepts a status ctl message', () => {
    const msg = { kind: 'status', phase: 'idle', findingCount: 3 }
    expect(parsePortMessage({ ctl: msg })).toEqual({ ctl: msg })
  })

  it('accepts a disconnect ctl message (panel Disconnect button, B43 C2 PR #139)', () => {
    expect(parsePortMessage({ ctl: { kind: 'disconnect' } })).toEqual({ ctl: { kind: 'disconnect' } })
  })

  it('accepts a ping ctl message (F1 keepalive, B43 C2 round 3)', () => {
    expect(parsePortMessage({ ctl: { kind: 'ping' } })).toEqual({ ctl: { kind: 'ping' } })
  })

  it.each([null, undefined, 'hello', 42, true])('returns null for non-object %s', (value) => {
    expect(parsePortMessage(value)).toBeNull()
  })

  it('returns null when the relay message fails both protocol parsers', () => {
    expect(parsePortMessage({ relay: { fw: 1, type: 'bogus', payload: {} } })).toBeNull()
  })

  it('returns null for a ctl message with an unknown kind', () => {
    expect(parsePortMessage({ ctl: { kind: 'nope' } })).toBeNull()
  })

  it('returns null for panelHello without a numeric windowId', () => {
    expect(parsePortMessage({ ctl: { kind: 'panelHello', windowId: '7' } })).toBeNull()
  })

  it('returns null for status with a non-numeric findingCount', () => {
    expect(parsePortMessage({
      ctl: { kind: 'status', phase: 'idle', findingCount: '3' },
    })).toBeNull()
  })

  it('returns null for detach without a string fieldId', () => {
    expect(parsePortMessage({ ctl: { kind: 'detach', fieldId: 42 } })).toBeNull()
  })

  it('returns null for status with an unknown phase', () => {
    expect(parsePortMessage({
      ctl: { kind: 'status', phase: 'bogus', findingCount: 0 },
    })).toBeNull()
  })
})
