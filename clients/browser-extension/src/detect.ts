// Field eligibility (spec: B43, C2 browser extension, Task 7; C3 Task 5).
// Eligibility covers <textarea> and contentEditable editing hosts (C3): the
// product spec's "designed for textarea/input" is realized here for both
// kinds. An <input>-capable adapter still doesn't exist, so <input> stays
// deliberately ineligible until one lands, rather than detected now and
// silently unable to mark/replace anything.
export const MIN_FIELD_WIDTH = 120
export const MIN_FIELD_HEIGHT = 40

export type EligibleField = HTMLTextAreaElement | HTMLElement
export type FieldKind = 'textarea' | 'contenteditable'

export function fieldKindOf(el: EligibleField): FieldKind {
  return el instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
}

function meetsSize(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.width >= MIN_FIELD_WIDTH && rect.height >= MIN_FIELD_HEIGHT
}

/** Visible, enabled, writable <textarea>, or a contentEditable editing host root, at least MIN_* in rendered size. */
export function isEligibleField(el: EventTarget | null): el is EligibleField {
  if (el instanceof HTMLTextAreaElement) {
    // :disabled catches direct el.disabled and fieldset-inherited disabling; check parent fieldset as fallback for incomplete DOM impls.
    const isDisabled = el.disabled || (el.closest('fieldset:disabled') !== null) || el.matches(':disabled')
    if (isDisabled || el.readOnly) return false
    return meetsSize(el)
  }
  // ContentEditable EDITING HOSTS only — the root of the editable region
  // (parent not editable), never inner nodes. isContentEditable is already
  // false under a contenteditable="false" ancestor. No disabled/readonly
  // analogue exists for contentEditable.
  if (el instanceof HTMLElement && el.isContentEditable && !el.parentElement?.isContentEditable) {
    return meetsSize(el)
  }
  return false
}

/**
 * Nearest ancestor-or-self of `target` for which isEligibleField is true, or
 * null. A plain ancestor walk rather than a contentEditable-specific climb:
 * isEligibleField itself already encodes the editing-root + size rules, so
 * the walk works unchanged whether target is the eligible root itself, an
 * editable inner node, or a non-editable island (a mention chip,
 * contenteditable="false" link card) nested inside an eligible host — its
 * ancestor chain still passes through that host's root. A nested editable
 * root still resolves to the OUTERMOST eligible ancestor, since the walk
 * keeps climbing past any inner root that isEligibleField itself rejects.
 */
export function resolveEligibleField(target: EventTarget | null): EligibleField | null {
  // Copilot round 2, F2: start from any Element, not just HTMLElement — a
  // mouseover/focusin can target an SVG descendant nested inside an eligible
  // CE host (an inline icon, a diagram) and SVGElement is not an
  // HTMLElement, so the old HTMLElement-only guard returned null before the
  // walk below ever got a chance to climb out of the SVG into the host.
  // parentElement climbs from an SVGElement into its enclosing HTMLElement
  // exactly like any other ancestor step; isEligibleField itself still
  // restricts what can actually match to HTMLTextAreaElement/HTMLElement
  // (see its own doc comment), so the return type is unchanged.
  if (!(target instanceof Element)) return null
  // Typed as the wider Element (not HTMLElement) so the isEligibleField
  // type guard's non-match branch doesn't collapse to `never` — EligibleField
  // is HTMLTextAreaElement | HTMLElement, so narrowing an HTMLElement-typed
  // variable against it excludes everything; Element has other subtypes
  // (SVGElement, etc.) left over, which still carry parentElement.
  let el: Element | null = target
  while (el) {
    if (isEligibleField(el)) return el
    el = el.parentElement
  }
  return null
}
