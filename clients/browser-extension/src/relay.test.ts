import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { envelope, PROTOCOL_VERSION, type ReadyMessage, type StatusMessage } from '../../../frontend/src/embed/protocol'
import { createRelay, HELLO_RETRY_MS, MAX_HELLO_ATTEMPTS } from './relay'
import type { PortMessage } from './messages'

const readyEnvelope = envelope<ReadyMessage>({
  type: 'ready',
  payload: { protocolVersion: PROTOCOL_VERSION, features: [] },
})

const statusEnvelope = envelope<StatusMessage>({
  type: 'status',
  payload: { phase: 'idle', findingCount: 0 },
})

const hostTextChangedEnvelope = {
  fw: PROTOCOL_VERSION,
  type: 'textChanged',
  payload: { fieldId: 'f1', text: 'hello' },
}

function makeCallbacks() {
  return {
    toEmbed: vi.fn<(msg: object) => void>(),
    toPort: vi.fn<(msg: PortMessage) => void>(),
    onReadyChange: vi.fn<(ready: boolean) => void>(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createRelay: hello loop', () => {
  it('sends a hello with kind browser-extension on start', () => {
    const cb = makeCallbacks()
    createRelay(cb, '0.1.0').start()
    expect(cb.toEmbed).toHaveBeenCalledWith({
      fw: PROTOCOL_VERSION,
      type: 'hello',
      payload: { host: { kind: 'browser-extension', version: '0.1.0' } },
    })
  })

  it('retries the hello every HELLO_RETRY_MS until ready arrives', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    expect(cb.toEmbed).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HELLO_RETRY_MS)
    expect(cb.toEmbed).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(HELLO_RETRY_MS)
    expect(cb.toEmbed).toHaveBeenCalledTimes(3)
    relay.fromEmbed(readyEnvelope)
    vi.advanceTimersByTime(HELLO_RETRY_MS * 5)
    expect(cb.toEmbed).toHaveBeenCalledTimes(3)
  })

  it('stops retrying after MAX_HELLO_ATTEMPTS and never fires onReadyChange', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    vi.advanceTimersByTime(HELLO_RETRY_MS * (MAX_HELLO_ATTEMPTS + 5))
    expect(cb.toEmbed).toHaveBeenCalledTimes(MAX_HELLO_ATTEMPTS)
    expect(cb.onReadyChange).not.toHaveBeenCalled()
  })
})

describe('createRelay: fromEmbed', () => {
  it('ready stops the loop and fires onReadyChange(true) exactly once', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    relay.fromEmbed(readyEnvelope)
    expect(cb.onReadyChange).toHaveBeenCalledTimes(1)
    expect(cb.onReadyChange).toHaveBeenCalledWith(true)
  })

  it('does not forward ready to the port', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    relay.fromEmbed(readyEnvelope)
    expect(cb.toPort).not.toHaveBeenCalled()
  })

  it('a second ready fires nothing further (edge guard)', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    relay.fromEmbed(readyEnvelope)
    relay.fromEmbed(readyEnvelope)
    expect(cb.onReadyChange).toHaveBeenCalledTimes(1)
  })

  it('after start() re-arms (iframe-load), the next ready fires onReadyChange(true) once more', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    relay.fromEmbed(readyEnvelope)
    expect(cb.onReadyChange).toHaveBeenCalledTimes(1)
    relay.start()
    relay.fromEmbed(readyEnvelope)
    expect(cb.onReadyChange).toHaveBeenCalledTimes(2)
    expect(cb.onReadyChange).toHaveBeenLastCalledWith(true)
  })

  it.each(['findings', 'status', 'applyReplacement', 'selectFinding'])(
    'forwards a parsed %s message to the port as {relay}',
    () => {
      const cb = makeCallbacks()
      const relay = createRelay(cb, '0.1.0')
      relay.start()
      relay.fromEmbed(statusEnvelope)
      expect(cb.toPort).toHaveBeenCalledWith({ relay: statusEnvelope })
    },
  )

  it('drops garbage silently', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    relay.fromEmbed({ nonsense: true })
    relay.fromEmbed(null)
    relay.fromEmbed('a string')
    expect(cb.toPort).not.toHaveBeenCalled()
    expect(cb.onReadyChange).not.toHaveBeenCalled()
  })
})

describe('createRelay: fromPort', () => {
  it('forwards a relay-wrapped host message to the embed verbatim (same object)', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.fromPort({ relay: hostTextChangedEnvelope })
    expect(cb.toEmbed).toHaveBeenCalledWith(hostTextChangedEnvelope)
    expect(cb.toEmbed.mock.calls[0][0]).toBe(hostTextChangedEnvelope)
  })

  it('ignores ctl messages', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.fromPort({ ctl: { kind: 'openPanel' } })
    expect(cb.toEmbed).not.toHaveBeenCalled()
  })

  it('drops garbage silently', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.fromPort({ nonsense: true })
    relay.fromPort(null)
    relay.fromPort('a string')
    expect(cb.toEmbed).not.toHaveBeenCalled()
  })
})

describe('createRelay: dispose', () => {
  it('stops the hello timer', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    expect(cb.toEmbed).toHaveBeenCalledTimes(1)
    relay.dispose()
    vi.advanceTimersByTime(HELLO_RETRY_MS * 5)
    expect(cb.toEmbed).toHaveBeenCalledTimes(1)
  })
})
