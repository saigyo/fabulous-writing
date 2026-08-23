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
//
// Copilot round 11, F1+F2: this module used to decide two things too late
// and too loosely. Both are now decided explicitly, at CAPTURE time, and
// baked into the Fingerprint itself:
//
//   F1 — ATTRIBUTE AMBIGUITY. Whether a name/aria-label match is trustworthy
//   used to be checked only at REBIND time (uniqueEligibleMatch below,
//   unconditionally). If two same-attribute textareas coexisted when the
//   session captured its fingerprint — one connected, one not — and the
//   connected one later vanished, the SURVIVOR alone looked "unique" to a
//   check that only ever saw the post-vanish document, and was silently
//   (and wrongly) rebound to as if it were the original field's
//   replacement. An attribute that is not unique in its own scope RIGHT NOW
//   (at capture) is never trusted as an identity at all — computeFingerprint
//   falls straight through to the position-based formIndex branch instead,
//   so there is no attribute-keyed search left to fool later.
//
//   F2 — SCOPE. A captured fingerprint now carries an explicit `scopeKind`:
//   'document' means the field had no form ancestor at capture — searching
//   the whole document for it is safe and correct BY DESIGN, not a
//   fallback. 'form' means the field DID have a form ancestor, and the
//   fingerprint is only ever valid scoped to that same form. If that form
//   cannot currently be resolved (e.g. mid-React-replacement, the form's own
//   subtree is transiently gone along with the field), the match REFUSES —
//   returns null — rather than quietly widening the search to the whole
//   document, where an unrelated unique match could exist and get rebound
//   to by mistake. scout.ts's poll loop already treats null as "nothing yet,
//   try again next tick" and gives up only once REACQUIRE_GRACE_MS elapses,
//   so refusing a single poll costs nothing when the form genuinely comes
//   back.
import { isEligibleField } from './detect'

export type ScopeKind = 'form' | 'document'

export interface Fingerprint {
  kind: 'id' | 'name' | 'aria' | 'formIndex'
  value: string
  // The closest form's identity at CAPTURE time, used (together with
  // scopeKind below) to scope the name/aria/formIndex searches back to the
  // field's own original container. Meaningless for scopeKind 'document'
  // (always the literal string 'document' there) and for kind 'id' (ids are
  // unique by contract, so id matches stay document-wide regardless).
  formId: string
  // F2: fixed at capture time — 'form' when the field had a form ancestor,
  // 'document' when it didn't. See the module comment above for what each
  // means to findFingerprintMatch.
  scopeKind: ScopeKind
}

function formIdentity(form: HTMLFormElement | null): string {
  if (!form) return 'document'
  if (form.id) return form.id
  const name = form.getAttribute('name')
  if (name) return name
  return String(Array.from(document.forms).indexOf(form))
}

// Inverse of formIdentity: resolves a captured formId back to a live form
// element, or null when the form can no longer be found (removed from the
// document, or an id/name that no longer resolves and isn't a valid forms[]
// index either). Only ever called for scopeKind 'form' — see
// resolveMatchScope below, which is what turns a null here into a refusal
// rather than a document-wide fallback.
function resolveForm(formId: string): HTMLFormElement | null {
  const forms = Array.from(document.forms)
  return forms.find((f) => f.id === formId || f.getAttribute('name') === formId) ?? forms[Number(formId)] ?? null
}

function textareaScope(root: ParentNode | null): HTMLTextAreaElement[] {
  return Array.from((root ?? document).querySelectorAll('textarea'))
}

// Rebind-time uniqueness check: exactly one ELIGIBLE (isEligibleField —
// scout.ts's own show/connect gate) match, or null. Used both as the
// capture-time ambiguity test (isUniqueInScope below) and as the rebind-time
// safety net in findFingerprintMatch itself — a fingerprint computeFingerprint
// no longer produces in an ambiguous shape, but findFingerprintMatch still
// refuses one if ever handed one directly.
function uniqueEligibleMatch(matches: NodeListOf<Element> | Element[]): HTMLTextAreaElement | null {
  const eligible = Array.from(matches).filter((el): el is HTMLTextAreaElement => isEligibleField(el))
  return eligible.length === 1 ? eligible[0] : null
}

// F1: is this selector unique, right now, within scopeRoot? Backs
// computeFingerprint's capture-time ambiguity decision — see the module
// comment above.
function isUniqueInScope(scopeRoot: ParentNode, selector: string): boolean {
  return uniqueEligibleMatch(scopeRoot.querySelectorAll(selector)) !== null
}

export function computeFingerprint(el: HTMLTextAreaElement): Fingerprint {
  const form = el.closest('form')
  const formId = formIdentity(form)
  const scopeKind: ScopeKind = form ? 'form' : 'document'
  if (el.id) return { kind: 'id', value: el.id, formId, scopeKind }

  // F1: every attribute-based candidate below is checked for uniqueness in
  // its own scope BEFORE it's trusted as this fingerprint's identity — not
  // after, at rebind time. A non-unique attribute is never used at all.
  const scopeRoot: ParentNode = form ?? document

  const name = el.getAttribute('name')
  if (name && isUniqueInScope(scopeRoot, `textarea[name="${CSS.escape(name)}"]`)) {
    return { kind: 'name', value: name, formId, scopeKind }
  }

  const aria = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby')
  if (aria) {
    const ariaSelector =
      `textarea[aria-label="${CSS.escape(aria)}"], textarea[aria-labelledby="${CSS.escape(aria)}"]`
    if (isUniqueInScope(scopeRoot, ariaSelector)) {
      return { kind: 'aria', value: aria, formId, scopeKind }
    }
  }

  const scope = textareaScope(form)
  return { kind: 'formIndex', value: `${formId}:${scope.indexOf(el)}`, formId, scopeKind }
}

// F2: the root to search at REBIND time — document for a 'document'-scoped
// fingerprint (safe and intentional, see module comment), the resolved form
// for a 'form'-scoped one, or null when that form cannot currently be
// resolved. null is the refusal signal every caller below turns straight
// into "return null" (never a document-wide fallback).
function resolveMatchScope(fingerprint: Fingerprint): ParentNode | null {
  if (fingerprint.scopeKind === 'document') return document
  return resolveForm(fingerprint.formId)
}

// Resolves a fingerprint against the CURRENT document — null when nothing
// matches (yet, or ever, for a 'form'-scoped fingerprint whose form is
// currently unresolvable — see resolveMatchScope). Only ever returns an
// eligible field (isEligibleField is scout.ts's own show/connect gate; a
// fingerprint match too small/hidden to have EVER shown a chip is not a
// field worth silently reconnecting to).
export function findFingerprintMatch(fingerprint: Fingerprint): HTMLTextAreaElement | null {
  let candidate: Element | null = null
  switch (fingerprint.kind) {
    case 'id':
      candidate = document.getElementById(fingerprint.value)
      break
    case 'name': {
      const scope = resolveMatchScope(fingerprint)
      if (!scope) return null
      candidate = uniqueEligibleMatch(scope.querySelectorAll(`textarea[name="${CSS.escape(fingerprint.value)}"]`))
      break
    }
    case 'aria': {
      const scope = resolveMatchScope(fingerprint)
      if (!scope) return null
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
      const index = Number(fingerprint.value.slice(sep + 1))
      const scope = resolveMatchScope(fingerprint)
      if (!scope) return null
      candidate = textareaScope(scope)[index] ?? null
      break
    }
  }
  if (!isEligibleField(candidate)) return null
  return candidate
}
