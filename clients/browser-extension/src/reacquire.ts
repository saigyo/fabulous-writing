// Field re-acquisition (live-test finding, B43 C2 PR #139): a React-style
// host — GitHub's own issue/comment composer included — commonly re-renders
// on blur and REPLACES the textarea node wholesale rather than mutating it
// in place. session.ts's MutationObserver correctly notices the old node
// leaving the document and self-detaches (sending fieldDisconnected) — that
// part is untouched, by design (see scout.ts's own reacquire wiring). What
// used to happen next was a hard stop: the chip went idle and the user had
// to notice and manually reconnect. This module is the "does the field
// that just vanished have an obvious replacement" half of a soft recovery —
// scout.ts owns the actual grace-window timing/session handoff.
//
// The fingerprint is captured from the LIVE element at session start (not
// at loss time — by the time a field is gone, a same-tick host mutation
// could plausibly have altered attributes on the way out, and snapshotting
// early is simply more predictable), in a priority order chosen to survive
// exactly this kind of re-render: an id/name/aria-label a host re-creates
// verbatim is a strong match; a bare index among the closest form's
// textareas is what's left when a host gives its fields no stable identity
// at all, and only survives a re-render that preserves field COUNT and
// ORDER (the common case for a blur-triggered rebuild, not a guarantee).
import { isEligibleField } from './detect'

export interface Fingerprint {
  kind: 'id' | 'name' | 'aria' | 'formIndex'
  value: string
  // Copilot round 10, F3: the closest form's identity at CAPTURE time (same
  // "capture early, not at loss time" rationale as the module comment
  // above). Used to scope the name/aria/formIndex searches below back to
  // the field's own original container instead of the whole document — see
  // findFingerprintMatch's own comment for why document-wide search is
  // unsafe for those three.
  formId: string
}

function formIdentity(form: HTMLFormElement | null): string {
  if (!form) return 'document'
  if (form.id) return form.id
  const name = form.getAttribute('name')
  if (name) return name
  return String(Array.from(document.forms).indexOf(form))
}

// Inverse of formIdentity: resolves a captured formId back to a live form
// element, or null (meaning "search the whole document") when the
// fingerprint was captured with no form ancestor, or the form itself can no
// longer be found (e.g. an id/name that no longer resolves and isn't a
// valid forms[] index either — same fallback shape formIdentity's own index
// branch already relied on).
function resolveForm(formId: string): HTMLFormElement | null {
  if (formId === 'document') return null
  const forms = Array.from(document.forms)
  return forms.find((f) => f.id === formId || f.getAttribute('name') === formId) ?? forms[Number(formId)] ?? null
}

function textareaScope(form: HTMLFormElement | null): HTMLTextAreaElement[] {
  const root: ParentNode = form ?? document
  return Array.from(root.querySelectorAll('textarea'))
}

export function computeFingerprint(el: HTMLTextAreaElement): Fingerprint {
  const form = el.closest('form')
  const formId = formIdentity(form)
  if (el.id) return { kind: 'id', value: el.id, formId }
  const name = el.getAttribute('name')
  if (name) return { kind: 'name', value: name, formId }
  const aria = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby')
  if (aria) return { kind: 'aria', value: aria, formId }
  const scope = textareaScope(form)
  return { kind: 'formIndex', value: `${formId}:${scope.indexOf(el)}`, formId }
}

// Copilot round 10, F3: name/aria/formIndex matches used to search the
// WHOLE document and take the first hit — on a page with multiple
// same-named comment forms (GitHub's own name="body" textareas, one per
// composer) that could silently rebind a session to the WRONG textarea and
// go on to edit its text. Scoped to the field's own original form (resolved
// from the fingerprint's captured formId) and required to be UNIQUE within
// that scope: zero or multiple eligible matches there is treated as
// ambiguous and refuses the match (null — scout.ts's caller falls through
// to giving up the reacquire, same as "nothing found"). The id branch stays
// document-wide — ids are unique by contract — but still runs through the
// same eligibility check below.
function uniqueEligibleMatch(matches: NodeListOf<Element> | Element[]): HTMLTextAreaElement | null {
  const eligible = Array.from(matches).filter((el): el is HTMLTextAreaElement => isEligibleField(el))
  return eligible.length === 1 ? eligible[0] : null
}

// Resolves a fingerprint against the CURRENT document — null when nothing
// matches (yet). Only ever returns an eligible field (isEligibleField is
// scout.ts's own show/connect gate; a fingerprint match too small/hidden to
// have EVER shown a chip is not a field worth silently reconnecting to).
export function findFingerprintMatch(fingerprint: Fingerprint): HTMLTextAreaElement | null {
  let candidate: Element | null = null
  switch (fingerprint.kind) {
    case 'id':
      candidate = document.getElementById(fingerprint.value)
      break
    case 'name': {
      const scope: ParentNode = resolveForm(fingerprint.formId) ?? document
      candidate = uniqueEligibleMatch(
        scope.querySelectorAll(`textarea[name="${CSS.escape(fingerprint.value)}"]`),
      )
      break
    }
    case 'aria': {
      const scope: ParentNode = resolveForm(fingerprint.formId) ?? document
      candidate = uniqueEligibleMatch(
        scope.querySelectorAll(
          `textarea[aria-label="${CSS.escape(fingerprint.value)}"], `
          + `textarea[aria-labelledby="${CSS.escape(fingerprint.value)}"]`,
        ),
      )
      break
    }
    case 'formIndex': {
      const sep = fingerprint.value.indexOf(':')
      const formId = fingerprint.value.slice(0, sep)
      const index = Number(fingerprint.value.slice(sep + 1))
      const form = resolveForm(formId)
      candidate = textareaScope(form)[index] ?? null
      break
    }
  }
  if (!isEligibleField(candidate)) return null
  return candidate
}
