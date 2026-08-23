import { beforeEach, describe, expect, it } from 'vitest'
import { computeFingerprint, findFingerprintMatch } from './reacquire'

function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 200, bottom: 80, width: 200, height: 80, x: 0, y: 0,
    toJSON() { return {} },
  })
}

function textarea(attrs: Record<string, string> = {}): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  stubRect(el)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('computeFingerprint', () => {
  it('prefers a non-empty id over everything else', () => {
    const el = textarea({ id: 'box', name: 'n', 'aria-label': 'a' })
    expect(computeFingerprint(el)).toEqual({ kind: 'id', value: 'box', formId: 'document' })
  })

  it('falls back to name when there is no id', () => {
    const el = textarea({ name: 'n', 'aria-label': 'a' })
    expect(computeFingerprint(el)).toEqual({ kind: 'name', value: 'n', formId: 'document' })
  })

  it('falls back to aria-label when there is no id/name', () => {
    const el = textarea({ 'aria-label': 'Comment body' })
    expect(computeFingerprint(el)).toEqual({ kind: 'aria', value: 'Comment body', formId: 'document' })
  })

  it('falls back to aria-labelledby when there is no aria-label', () => {
    const el = textarea({ 'aria-labelledby': 'label-id' })
    expect(computeFingerprint(el)).toEqual({ kind: 'aria', value: 'label-id', formId: 'document' })
  })

  it('falls back to form identity + index among the form\'s own textareas when there is no other identity', () => {
    const form = document.createElement('form')
    form.id = 'composer'
    document.body.appendChild(form)
    const other = textarea()
    const el = textarea()
    form.append(other, el)

    expect(computeFingerprint(el)).toEqual({ kind: 'formIndex', value: 'composer:1', formId: 'composer' })
  })

  it('falls back to a bare document scope when the field has no form ancestor', () => {
    const other = textarea()
    const el = textarea()
    document.body.append(other, el)

    expect(computeFingerprint(el)).toEqual({ kind: 'formIndex', value: 'document:1', formId: 'document' })
  })

  // Copilot round 10, F3: name/aria fingerprints now also capture the
  // closest form's identity so a later reacquire can be scoped back to it.
  it('captures the closest form\'s identity alongside a name/aria fingerprint', () => {
    const form = document.createElement('form')
    form.id = 'composer'
    document.body.appendChild(form)
    const el = textarea({ name: 'body' })
    form.appendChild(el)

    expect(computeFingerprint(el)).toEqual({ kind: 'name', value: 'body', formId: 'composer' })
  })
})

describe('findFingerprintMatch', () => {
  it('matches by id', () => {
    const el = textarea({ id: 'box' })
    document.body.appendChild(el)
    expect(findFingerprintMatch({ kind: 'id', value: 'box', formId: 'document' })).toBe(el)
  })

  it('matches by name', () => {
    const el = textarea({ name: 'body' })
    document.body.appendChild(el)
    expect(findFingerprintMatch({ kind: 'name', value: 'body', formId: 'document' })).toBe(el)
  })

  it('matches by aria-label', () => {
    const el = textarea({ 'aria-label': 'Comment body' })
    document.body.appendChild(el)
    expect(findFingerprintMatch({ kind: 'aria', value: 'Comment body', formId: 'document' })).toBe(el)
  })

  it('matches by form identity + index', () => {
    const form = document.createElement('form')
    form.id = 'composer'
    document.body.appendChild(form)
    const other = textarea()
    const el = textarea()
    form.append(other, el)

    expect(findFingerprintMatch({ kind: 'formIndex', value: 'composer:1', formId: 'composer' })).toBe(el)
  })

  it('returns null when nothing matches', () => {
    expect(findFingerprintMatch({ kind: 'id', value: 'nope', formId: 'document' })).toBeNull()
  })

  it('returns null for a match that exists but is not an eligible field (too small)', () => {
    const el = document.createElement('textarea')
    el.id = 'tiny'
    // No stubRect — happy-dom's default rect is 0x0, below MIN_FIELD_*.
    document.body.appendChild(el)
    expect(findFingerprintMatch({ kind: 'id', value: 'tiny', formId: 'document' })).toBeNull()
  })

  it('a same-shaped React-style rebuild (id-based field replaced by a fresh node with the same id) matches the NEW node', () => {
    const form = document.createElement('form')
    document.body.appendChild(form)
    const original = textarea({ id: 'box' })
    form.appendChild(original)
    const fingerprint = computeFingerprint(original)

    // Mimic a blur-triggered React rebuild: the original node is removed
    // and a fresh one with the same id takes its place.
    original.remove()
    const rebuilt = textarea({ id: 'box' })
    form.appendChild(rebuilt)

    const match = findFingerprintMatch(fingerprint)
    expect(match).toBe(rebuilt)
    expect(match).not.toBe(original)
  })

  // Copilot round 10, F3: name/aria/formIndex fingerprint matches used to
  // search the WHOLE document and take the first hit — on a page with
  // multiple same-named comment forms (GitHub's own name="body" textareas,
  // one per composer) that could silently rebind to the WRONG textarea.
  describe('document-unique scoping (F3, round 10)', () => {
    it('a same-form rebuild rebinds within the ORIGINAL form, never the other same-named form', () => {
      const formA = document.createElement('form')
      formA.id = 'form-a'
      const formB = document.createElement('form')
      formB.id = 'form-b'
      document.body.append(formA, formB)
      const bodyA = textarea({ name: 'body' })
      formA.appendChild(bodyA)
      const bodyB = textarea({ name: 'body' })
      formB.appendChild(bodyB)

      // A session was connected to the SECOND form's field.
      const fingerprint = computeFingerprint(bodyB)

      // React-style rebuild inside form-b only: bodyB is replaced by a
      // fresh textarea with the same name, still inside form-b.
      bodyB.remove()
      const rebuiltB = textarea({ name: 'body' })
      formB.appendChild(rebuiltB)

      const match = findFingerprintMatch(fingerprint)
      expect(match).toBe(rebuiltB)
      expect(match).not.toBe(bodyA)
    })

    it('refuses (returns null) when an eligible name match is ambiguous within the searched scope', () => {
      // No form ancestor for either — both share the document-wide scope.
      const other = textarea({ name: 'body' })
      const el = textarea({ name: 'body' })
      document.body.append(other, el)
      const fingerprint = computeFingerprint(el)

      // Two equally-eligible textarea[name="body"] fields at document
      // scope: neither is a safe rebind target.
      expect(findFingerprintMatch(fingerprint)).toBeNull()
    })

    it('a unique-in-form match still rebinds', () => {
      const form = document.createElement('form')
      form.id = 'composer'
      document.body.appendChild(form)
      const el = textarea({ name: 'body' })
      form.appendChild(el)
      const fingerprint = computeFingerprint(el)

      el.remove()
      const rebuilt = textarea({ name: 'body' })
      form.appendChild(rebuilt)

      expect(findFingerprintMatch(fingerprint)).toBe(rebuilt)
    })
  })
})
