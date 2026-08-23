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
    expect(computeFingerprint(el)).toEqual({ kind: 'id', value: 'box', formId: 'document', scopeKind: 'document' })
  })

  it('falls back to name when there is no id', () => {
    const el = textarea({ name: 'n', 'aria-label': 'a' })
    document.body.appendChild(el)
    expect(computeFingerprint(el)).toEqual({ kind: 'name', value: 'n', formId: 'document', scopeKind: 'document' })
  })

  it('falls back to aria-label when there is no id/name', () => {
    const el = textarea({ 'aria-label': 'Comment body' })
    document.body.appendChild(el)
    expect(computeFingerprint(el)).toEqual(
      { kind: 'aria', value: 'Comment body', formId: 'document', scopeKind: 'document' },
    )
  })

  it('falls back to aria-labelledby when there is no aria-label', () => {
    const el = textarea({ 'aria-labelledby': 'label-id' })
    document.body.appendChild(el)
    expect(computeFingerprint(el)).toEqual(
      { kind: 'aria', value: 'label-id', formId: 'document', scopeKind: 'document' },
    )
  })

  it('falls back to form identity + index among the form\'s own textareas when there is no other identity', () => {
    const form = document.createElement('form')
    form.id = 'composer'
    document.body.appendChild(form)
    const other = textarea()
    const el = textarea()
    form.append(other, el)

    expect(computeFingerprint(el)).toEqual(
      { kind: 'formIndex', value: 'composer:1', formId: 'composer', scopeKind: 'form' },
    )
  })

  it('falls back to a bare document scope when the field has no form ancestor', () => {
    const other = textarea()
    const el = textarea()
    document.body.append(other, el)

    expect(computeFingerprint(el)).toEqual(
      { kind: 'formIndex', value: 'document:1', formId: 'document', scopeKind: 'document' },
    )
  })

  // Copilot round 10, F3: name/aria fingerprints now also capture the
  // closest form's identity so a later reacquire can be scoped back to it.
  it('captures the closest form\'s identity alongside a name/aria fingerprint', () => {
    const form = document.createElement('form')
    form.id = 'composer'
    document.body.appendChild(form)
    const el = textarea({ name: 'body' })
    form.appendChild(el)

    expect(computeFingerprint(el)).toEqual({ kind: 'name', value: 'body', formId: 'composer', scopeKind: 'form' })
  })
})

describe('findFingerprintMatch', () => {
  it('matches by id', () => {
    const el = textarea({ id: 'box' })
    document.body.appendChild(el)
    expect(findFingerprintMatch({ kind: 'id', value: 'box', formId: 'document', scopeKind: 'document' })).toBe(el)
  })

  it('matches by name', () => {
    const el = textarea({ name: 'body' })
    document.body.appendChild(el)
    expect(findFingerprintMatch({ kind: 'name', value: 'body', formId: 'document', scopeKind: 'document' })).toBe(el)
  })

  it('matches by aria-label', () => {
    const el = textarea({ 'aria-label': 'Comment body' })
    document.body.appendChild(el)
    expect(
      findFingerprintMatch({ kind: 'aria', value: 'Comment body', formId: 'document', scopeKind: 'document' }),
    ).toBe(el)
  })

  it('matches by form identity + index', () => {
    const form = document.createElement('form')
    form.id = 'composer'
    document.body.appendChild(form)
    const other = textarea()
    const el = textarea()
    form.append(other, el)

    expect(
      findFingerprintMatch({ kind: 'formIndex', value: 'composer:1', formId: 'composer', scopeKind: 'form' }),
    ).toBe(el)
  })

  it('returns null when nothing matches', () => {
    expect(findFingerprintMatch({ kind: 'id', value: 'nope', formId: 'document', scopeKind: 'document' })).toBeNull()
  })

  it('returns null for a match that exists but is not an eligible field (too small)', () => {
    const el = document.createElement('textarea')
    el.id = 'tiny'
    // No stubRect — happy-dom's default rect is 0x0, below MIN_FIELD_*.
    document.body.appendChild(el)
    expect(
      findFingerprintMatch({ kind: 'id', value: 'tiny', formId: 'document', scopeKind: 'document' }),
    ).toBeNull()
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

// Copilot round 11, F1+F2: reacquire's scope/ambiguity semantics restructured
// into one explicit state machine (see reacquire.ts's own module comment).
//
// F1 — ambiguity is now decided at CAPTURE time: an attribute that is not
// unique in its own scope when the session starts is NEVER used as this
// fingerprint's identity, full stop — not "unique enough at rebind time",
// which is what let a same-attribute SURVIVOR get mistaken for the
// connected field's replacement once the connected field itself vanished.
//
// F2 — every fingerprint now carries an explicit scopeKind, fixed at
// capture: 'document' (no form ancestor — document-wide search is safe BY
// DESIGN) or 'form' (a form ancestor existed — the match is scoped to that
// same form, and REFUSES rather than widening to the whole document if that
// form cannot currently be resolved).
//
// Scenario table: {attribute unique at capture, ambiguous at capture} x
// {form present, form absent this poll, form replaced-and-returns} x
// {survivor with same attribute exists, doesn't}.
describe('Copilot round 11, F1+F2: capture-time ambiguity and explicit form/document scoping', () => {
  describe('F1: capture-time ambiguity decides the fingerprint kind, not rebind-time', () => {
    it('unique at capture, form present -> kind stays "name", rebinds through a React-style replace', () => {
      const form = document.createElement('form')
      form.id = 'composer'
      document.body.appendChild(form)
      const el = textarea({ name: 'body' })
      form.appendChild(el)

      const fingerprint = computeFingerprint(el)
      expect(fingerprint.kind).toBe('name')

      el.remove()
      const rebuilt = textarea({ name: 'body' })
      form.appendChild(rebuilt)

      expect(findFingerprintMatch(fingerprint)).toBe(rebuilt)
    })

    // The headline bug: two same-named textareas coexist AT CAPTURE — one
    // connected (el), one not (survivor). The old code decided ambiguity
    // only at rebind time, so once el vanished the survivor alone looked
    // "unique" and was silently (and wrongly) treated as el's replacement.
    it('ambiguous at capture (a same-attribute survivor already coexists) -> falls to formIndex, so the survivor is never mistaken for the connected field\'s replacement', () => {
      const form = document.createElement('form')
      form.id = 'composer'
      document.body.appendChild(form)
      const survivor = textarea({ name: 'body' })
      const el = textarea({ name: 'body' })
      form.append(survivor, el)

      const fingerprint = computeFingerprint(el)
      expect(fingerprint).toEqual({ kind: 'formIndex', value: 'composer:1', formId: 'composer', scopeKind: 'form' })

      // el vanishes (mid-React-replacement); only the survivor with the
      // SAME name attribute is left. A name-keyed match would wrongly
      // resolve to it; the formIndex fingerprint never even tries.
      el.remove()
      expect(findFingerprintMatch(fingerprint)).toBeNull()

      // The field comes back at the same POSITION (index 1) inside the
      // form — the only identity this fingerprint ever trusted.
      const rebuilt = textarea({ name: 'body' })
      form.appendChild(rebuilt)
      expect(findFingerprintMatch(fingerprint)).toBe(rebuilt)
    })

    it('ambiguous at capture with no form ancestor (document scope) also falls to formIndex', () => {
      const survivor = textarea({ 'aria-label': 'Comment' })
      const el = textarea({ 'aria-label': 'Comment' })
      document.body.append(survivor, el)

      expect(computeFingerprint(el)).toEqual(
        { kind: 'formIndex', value: 'document:1', formId: 'document', scopeKind: 'document' },
      )
    })

    // Defense in depth: findFingerprintMatch itself still refuses an
    // ambiguous match if ever handed one directly — computeFingerprint
    // above just no longer produces this shape in practice.
    it('findFingerprintMatch still refuses a hand-fed ambiguous name fingerprint (rebind-time safety net)', () => {
      const other = textarea({ name: 'body' })
      const el = textarea({ name: 'body' })
      document.body.append(other, el)

      expect(
        findFingerprintMatch({ kind: 'name', value: 'body', formId: 'document', scopeKind: 'document' }),
      ).toBeNull()
    })
  })

  describe('F2: a "form" fingerprint refuses (never falls back to document) when the form cannot be resolved', () => {
    it('form present this poll -> normal scoped rebind', () => {
      const formA = document.createElement('form')
      formA.id = 'form-a'
      document.body.appendChild(formA)
      const el = textarea({ name: 'body' })
      formA.appendChild(el)
      const fingerprint = computeFingerprint(el)
      expect(fingerprint.scopeKind).toBe('form')

      el.remove()
      const rebuilt = textarea({ name: 'body' })
      formA.appendChild(rebuilt)
      expect(findFingerprintMatch(fingerprint)).toBe(rebuilt)
    })

    // The headline bug: the field's own form is temporarily gone (mid
    // React-replacement of a larger subtree) while a DIFFERENT, unique
    // same-named textarea sits outside any form elsewhere in the document.
    // A document-wide fallback would find and rebind to it; refusing is the
    // only safe response — the original form may still come back.
    it('form absent this poll, with a document-wide same-attribute match available elsewhere -> refuses (null), never rebinds to the other field', () => {
      const form = document.createElement('form')
      form.id = 'composer'
      document.body.appendChild(form)
      const el = textarea({ name: 'body' })
      form.appendChild(el)
      const fingerprint = computeFingerprint(el)

      // The entire form (not just the field) is torn out.
      form.remove()
      // A DIFFERENT same-named textarea, outside any form, would be a
      // "unique document-wide match" if searched that way.
      const decoy = textarea({ name: 'body' })
      document.body.appendChild(decoy)

      expect(findFingerprintMatch(fingerprint)).toBeNull()
    })

    it('form replaced-and-returns: refuses while absent, then rebinds once the form (and field) are back', () => {
      const form = document.createElement('form')
      form.id = 'composer'
      document.body.appendChild(form)
      const el = textarea({ name: 'body' })
      form.appendChild(el)
      const fingerprint = computeFingerprint(el)

      form.remove()
      expect(findFingerprintMatch(fingerprint)).toBeNull()

      // The host re-inserts a FRESH form with the same id, holding a fresh
      // field with the same name — the common "whole composer subtree got
      // replaced" case.
      const newForm = document.createElement('form')
      newForm.id = 'composer'
      document.body.appendChild(newForm)
      const rebuilt = textarea({ name: 'body' })
      newForm.appendChild(rebuilt)

      expect(findFingerprintMatch(fingerprint)).toBe(rebuilt)
    })

    it('formIndex kind also refuses rather than searching document when its own form is absent', () => {
      const form = document.createElement('form')
      form.id = 'composer'
      document.body.appendChild(form)
      const other = textarea()
      const el = textarea()
      form.append(other, el)
      const fingerprint = computeFingerprint(el)
      expect(fingerprint.kind).toBe('formIndex')

      form.remove()
      // Decoy textareas at document-wide indices, outside any form — a
      // document-wide fallback would land on one of these.
      document.body.appendChild(textarea())
      document.body.appendChild(textarea())

      expect(findFingerprintMatch(fingerprint)).toBeNull()
    })

    it('a "document" fingerprint (no form ancestor at capture) DOES search document-wide -- by design, not a bug', () => {
      const el = textarea({ name: 'solo' })
      document.body.appendChild(el)
      const fingerprint = computeFingerprint(el)
      expect(fingerprint.scopeKind).toBe('document')

      el.remove()
      const rebuilt = textarea({ name: 'solo' })
      document.body.appendChild(rebuilt)

      expect(findFingerprintMatch(fingerprint)).toBe(rebuilt)
    })
  })
})
