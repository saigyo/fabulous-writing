// Field eligibility (spec: B43, C2 browser extension, Task 7; C3 Task 5). v1
// is textarea-only: the product spec's "designed for textarea/input" is
// realized here only for <textarea> — an <input>-capable adapter doesn't
// exist yet (session.ts is built directly on createTextareaAdapter), so an
// <input> is deliberately kept ineligible until that adapter lands, rather
// than detected now and silently unable to mark/replace anything.
// textarea + contentEditable editing hosts; <input> still deliberately
// ineligible.
export const MIN_FIELD_WIDTH = 120
export const MIN_FIELD_HEIGHT = 40

export type EligibleField = HTMLTextAreaElement | HTMLElement
export type FieldKind = 'textarea' | 'contenteditable'

export function fieldKindOf(el: EligibleField): FieldKind {
  return el instanceof HTMLTextAreaElement ? 'textarea' : 'contenteditable'
}

function editingRootOf(el: HTMLElement): HTMLElement {
  let root = el
  while (root.parentElement?.isContentEditable) root = root.parentElement
  return root
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

/** Climb from an inner node of an editable region to its eligible root; identity for an already-eligible target; null otherwise. */
export function resolveEligibleField(target: EventTarget | null): EligibleField | null {
  if (isEligibleField(target)) return target
  if (target instanceof HTMLElement && target.isContentEditable) {
    const root = editingRootOf(target)
    if (isEligibleField(root)) return root
  }
  return null
}
