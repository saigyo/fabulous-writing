// @vitest-environment happy-dom
//
// session.ts is the content-side protocol host role for one field — it
// ports frontend/src/simulator/main.ts's connected-state logic (see that
// file and its main.test.ts) off main.ts's DOM/button harness onto a plain
// `send` callback the content script (scout.ts, Task 7) supplies. Every
// guard main.ts grew across C1 review rounds carries over: the
// not-connected (here: detached) refusal, the foreign-fieldId refusal with
// empty text, and the try/catch around applyReplacement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Envelope, EmbedMessage, HostMessage } from '../../../frontend/src/embed/protocol'
import { PROTOCOL_VERSION } from '../../../frontend/src/embed/protocol'
import { startSession } from './session'

let el: HTMLTextAreaElement

beforeEach(() => {
  el = document.createElement('textarea')
  el.value = 'The quikc brown fox'
  document.body.appendChild(el)
})

afterEach(() => {
  el.remove()
})

function embedMsg(msg: EmbedMessage): Envelope<EmbedMessage> {
  return { fw: PROTOCOL_VERSION, ...msg }
}

function lastSent(send: ReturnType<typeof vi.fn>): Envelope<HostMessage> {
  const calls = send.mock.calls
  return calls[calls.length - 1][0] as Envelope<HostMessage>
}

describe('startSession: fieldConnected on start', () => {
  it('sends fieldConnected with the extracted text, capabilities, and meta', () => {
    const send = vi.fn()

    const session = startSession(el, send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(lastSent(send)).toMatchObject({
      fw: PROTOCOL_VERSION,
      type: 'fieldConnected',
      payload: {
        fieldId: session.fieldId,
        text: 'The quikc brown fox',
        capabilities: { mark: 'overlay', replace: 'reliable' },
        meta: { fieldKind: 'textarea' },
      },
    })
    const msg = lastSent(send) as Envelope<HostMessage> & { payload: { meta: { url: string } } }
    expect(typeof msg.payload.meta.url).toBe('string')
    expect(msg.payload.meta.url.length).toBeGreaterThan(0)

    session.detach()
  })
})

describe('startSession: fieldId', () => {
  it('is prefixed with fw-', () => {
    const send = vi.fn()
    const session = startSession(el, send)

    expect(session.fieldId.startsWith('fw-')).toBe(true)
    expect(session.fieldId.length).toBeGreaterThan('fw-'.length)

    session.detach()
  })

  it('falls back to a Date.now()/Math.random id when crypto.randomUUID is absent (plain-http content-script realm)', () => {
    // crypto.randomUUID is secure-context-gated; on a plain-http page a
    // content script's shared realm has it undefined. randomUUID lives on
    // Crypto.prototype in this test env, so `delete crypto.randomUUID`
    // alone wouldn't remove it — shadow it with an own `undefined` property
    // instead, matching what an absent method looks like to `?.()`.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })

    const send = vi.fn()
    const session = startSession(el, send)

    expect(session.fieldId.startsWith('fw-')).toBe(true)
    expect(session.fieldId).not.toBe('fw-')

    session.detach()
    delete (crypto as { randomUUID?: unknown }).randomUUID
  })
})

describe('startSession: textChanged on input', () => {
  it('sends textChanged with the full text on the field input event', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    send.mockClear()

    el.value = 'The quick brown fox'
    el.dispatchEvent(new Event('input'))

    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'textChanged',
      payload: { fieldId: session.fieldId, text: 'The quick brown fox' },
    })

    session.detach()
  })
})

describe('startSession: findings -> adapter marks', () => {
  it('a findings message for this fieldId marks the overlay DOM', () => {
    const send = vi.fn()
    const session = startSession(el, send)

    session.handleEmbedMessage(embedMsg({
      type: 'findings',
      payload: {
        fieldId: session.fieldId,
        findings: [{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }],
      },
    }))

    const mark = document.querySelector('[data-finding-ids~="f1"]')
    expect(mark).not.toBeNull()
    expect(mark?.className).toContain('fw-mark-error')

    session.detach()
  })

  it('a findings message for a foreign fieldId is ignored', () => {
    const send = vi.fn()
    const session = startSession(el, send)

    session.handleEmbedMessage(embedMsg({
      type: 'findings',
      payload: {
        fieldId: 'not-this-field',
        findings: [{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }],
      },
    }))

    expect(document.querySelector('[data-finding-ids~="f1"]')).toBeNull()

    session.detach()
  })
})

describe('startSession: selectFinding -> track + flash', () => {
  it('flashes the finding named by a non-null selectFinding', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    session.handleEmbedMessage(embedMsg({
      type: 'findings',
      payload: {
        fieldId: session.fieldId,
        findings: [{ id: 'f1', from: 4, to: 9, severity: 'error', category: 'spelling' }],
      },
    }))

    session.handleEmbedMessage(embedMsg({
      type: 'selectFinding',
      payload: { fieldId: session.fieldId, id: 'f1' },
    }))

    const mark = document.querySelector('[data-finding-ids~="f1"]')
    expect(mark?.className).toContain('fw-mark-flash')

    session.detach()
  })
})

describe('startSession: click -> markingClicked', () => {
  it('hit-tests the caret against the last findings and sends markingClicked, tracking the selection for the next cycle', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    session.handleEmbedMessage(embedMsg({
      type: 'findings',
      payload: {
        fieldId: session.fieldId,
        findings: [{ id: 'f1', from: 0, to: 5, severity: 'warning', category: 'style' }],
      },
    }))
    send.mockClear()

    el.selectionStart = 2
    el.selectionEnd = 2
    el.dispatchEvent(new Event('click'))

    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'markingClicked',
      payload: { fieldId: session.fieldId, id: 'f1' },
    })

    session.detach()
  })
})

describe('startSession: applyReplacement', () => {
  it('happy path mutates the textarea and echoes ok:true with the new text and the same requestId', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    send.mockClear()

    session.handleEmbedMessage(embedMsg({
      type: 'applyReplacement',
      requestId: 'r1',
      payload: { fieldId: session.fieldId, from: 4, to: 9, insert: 'quick', expectedText: 'quikc' },
    }))

    expect(el.value).toBe('The quick brown fox')
    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'replaceResult',
      requestId: 'r1',
      payload: { fieldId: session.fieldId, ok: true, text: 'The quick brown fox' },
    })

    session.detach()
  })

  it('expectedText mismatch echoes ok:false without mutating the textarea', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    const before = el.value
    send.mockClear()

    session.handleEmbedMessage(embedMsg({
      type: 'applyReplacement',
      requestId: 'r2',
      payload: { fieldId: session.fieldId, from: 4, to: 9, insert: 'quick', expectedText: 'wrong' },
    }))

    expect(el.value).toBe(before)
    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'replaceResult',
      requestId: 'r2',
      payload: { fieldId: session.fieldId, ok: false, text: before },
    })

    session.detach()
  })

  it('a foreign fieldId echoes ok:false with the FOREIGN fieldId and empty text, textarea untouched', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    const before = el.value
    send.mockClear()

    session.handleEmbedMessage(embedMsg({
      type: 'applyReplacement',
      requestId: 'r3',
      payload: { fieldId: 'not-this-field', from: 0, to: 5, insert: 'xxxxx', expectedText: before.slice(0, 5) },
    }))

    expect(el.value).toBe(before)
    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'replaceResult',
      requestId: 'r3',
      payload: { fieldId: 'not-this-field', ok: false, text: '' },
    })

    session.detach()
  })

  it('a throwing adapter is caught and answered ok:false with the current text instead of propagating', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    const before = el.value
    send.mockClear()
    vi.spyOn(el, 'setSelectionRange').mockImplementation(() => {
      throw new DOMException('boom')
    })

    session.handleEmbedMessage(embedMsg({
      type: 'applyReplacement',
      requestId: 'r4',
      payload: { fieldId: session.fieldId, from: 0, to: 5, insert: 'xxxxx', expectedText: before.slice(0, 5) },
    }))

    expect(el.value).toBe(before)
    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'replaceResult',
      requestId: 'r4',
      payload: { fieldId: session.fieldId, ok: false, text: before },
    })

    session.detach()
  })

  it('is refused with the current text once the session has been detached', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    session.detach()
    el.value = 'mutated after detach'
    send.mockClear()

    session.handleEmbedMessage(embedMsg({
      type: 'applyReplacement',
      requestId: 'r5',
      payload: { fieldId: session.fieldId, from: 0, to: 5, insert: 'xxxxx', expectedText: 'mutat' },
    }))

    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'replaceResult',
      requestId: 'r5',
      payload: { fieldId: session.fieldId, ok: false, text: 'mutated after detach' },
    })
  })
})

describe('startSession: stop()', () => {
  it('sends fieldDisconnected and disposes the adapter (overlay removed)', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    expect(el.previousElementSibling?.className).toBe('fw-mirror-overlay')
    send.mockClear()

    session.stop()

    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'fieldDisconnected',
      payload: { fieldId: session.fieldId },
    })
    expect(el.previousElementSibling?.className).not.toBe('fw-mirror-overlay')
  })
})

describe('startSession: detach()', () => {
  it('is idempotent — a second call is a no-op', () => {
    const send = vi.fn()
    const session = startSession(el, send)

    session.detach()
    expect(() => session.detach()).not.toThrow()
  })

  it('does not itself send fieldDisconnected (unlike stop())', () => {
    const send = vi.fn()
    const session = startSession(el, send)
    send.mockClear()

    session.detach()

    expect(send).not.toHaveBeenCalled()
  })
})

describe('startSession: Turbo-style auto-disconnect', () => {
  it('removing the field from the DOM triggers stop() via MutationObserver', async () => {
    const send = vi.fn()
    const session = startSession(el, send)
    send.mockClear()

    el.remove()
    await Promise.resolve()

    expect(lastSent(send)).toEqual({
      fw: PROTOCOL_VERSION,
      type: 'fieldDisconnected',
      payload: { fieldId: session.fieldId },
    })
  })
})
