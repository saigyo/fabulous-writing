import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  envelope, PROTOCOL_VERSION,
  type ApplyReplacementMessage, type FindingsMessage, type ReadyMessage,
  type SelectFindingMessage, type StatusMessage,
} from '../../../frontend/src/embed/protocol'
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

const findingsEnvelope = envelope<FindingsMessage>({
  type: 'findings',
  payload: {
    fieldId: 'f1',
    findings: [{ id: 'm1', from: 0, to: 3, severity: 'error', category: 'spelling' }],
  },
})

const applyReplacementEnvelope = envelope<ApplyReplacementMessage>({
  type: 'applyReplacement',
  requestId: 'r1',
  payload: { fieldId: 'f1', from: 0, to: 3, insert: 'cat', expectedText: 'cta' },
})

const selectFindingEnvelope = envelope<SelectFindingMessage>({
  type: 'selectFinding',
  payload: { fieldId: 'f1', id: 'm1' },
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

  it('reload sequence: ready -> true; start() re-arm -> false before the next hello; next ready -> true again', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    relay.start()
    relay.fromEmbed(readyEnvelope)
    expect(cb.onReadyChange).toHaveBeenCalledTimes(1)
    expect(cb.onReadyChange).toHaveBeenLastCalledWith(true)

    const helloCallsSoFar = cb.toEmbed.mock.calls.length
    relay.start() // the iframe 'load' re-arm
    expect(cb.onReadyChange).toHaveBeenCalledTimes(2)
    expect(cb.onReadyChange).toHaveBeenLastCalledWith(false)
    // The false transition (-> ctl embedReady:false, which unwinds the SW
    // registry's panelReady flag) must land before any hello traffic from
    // this same re-arm — otherwise a fast embed could answer the new hello
    // with `ready` while the registry still believes the old session live.
    const falseOrder = cb.onReadyChange.mock.invocationCallOrder.at(-1)
    const nextHelloOrder = cb.toEmbed.mock.invocationCallOrder[helloCallsSoFar]
    expect(falseOrder).toBeLessThan(nextHelloOrder)

    relay.fromEmbed(readyEnvelope)
    expect(cb.onReadyChange).toHaveBeenCalledTimes(3)
    expect(cb.onReadyChange).toHaveBeenLastCalledWith(true)
  })

  it.each([
    ['findings', findingsEnvelope],
    ['status', statusEnvelope],
    ['applyReplacement', applyReplacementEnvelope],
    ['selectFinding', selectFindingEnvelope],
  ] as [string, object][])(
    'forwards a parsed %s message to the port as {relay}',
    (_name, msgEnvelope) => {
      const cb = makeCallbacks()
      const relay = createRelay(cb, '0.1.0')
      relay.start()
      relay.fromEmbed(msgEnvelope)
      expect(cb.toPort).toHaveBeenCalledWith({ relay: msgEnvelope })
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

  it('drops a relay-wrapped embed-direction envelope arriving on the port (direction guard)', () => {
    const cb = makeCallbacks()
    const relay = createRelay(cb, '0.1.0')
    // readyEnvelope parses fine as an EmbedMessage (parsePortMessage accepts
    // either direction generically), but a panel port never legitimately
    // carries one — fromPort's explicit parseHostMessage check must drop it.
    relay.fromPort({ relay: readyEnvelope })
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
