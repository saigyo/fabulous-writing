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
}

function formIdentity(form: HTMLFormElement | null): string {
  if (!form) return 'document'
  if (form.id) return form.id
  const name = form.getAttribute('name')
  if (name) return name
  return String(Array.from(document.forms).indexOf(form))
}

function textareaScope(form: HTMLFormElement | null): HTMLTextAreaElement[] {
  const root: ParentNode = form ?? document
  return Array.from(root.querySelectorAll('textarea'))
}

export function computeFingerprint(el: HTMLTextAreaElement): Fingerprint {
  if (el.id) return { kind: 'id', value: el.id }
  const name = el.getAttribute('name')
  if (name) return { kind: 'name', value: name }
  const aria = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby')
  if (aria) return { kind: 'aria', value: aria }
  const form = el.closest('form')
  const scope = textareaScope(form)
  return { kind: 'formIndex', value: `${formIdentity(form)}:${scope.indexOf(el)}` }
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
    case 'name':
      candidate = document.querySelector(`textarea[name="${CSS.escape(fingerprint.value)}"]`)
      break
    case 'aria':
      candidate = document.querySelector(
        `textarea[aria-label="${CSS.escape(fingerprint.value)}"], `
        + `textarea[aria-labelledby="${CSS.escape(fingerprint.value)}"]`,
      )
      break
    case 'formIndex': {
      const sep = fingerprint.value.indexOf(':')
      const formId = fingerprint.value.slice(0, sep)
      const index = Number(fingerprint.value.slice(sep + 1))
      const forms = Array.from(document.forms)
      const form = formId === 'document' ? null
        : forms.find((f) => f.id === formId || f.getAttribute('name') === formId) ?? forms[Number(formId)] ?? null
      candidate = textareaScope(form)[index] ?? null
      break
    }
  }
  if (!isEligibleField(candidate)) return null
  return candidate
}
