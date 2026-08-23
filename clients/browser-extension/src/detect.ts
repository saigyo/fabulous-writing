// Field eligibility (spec: B43, C2 browser extension, Task 7). v1 is
// textarea-only: the product spec's "designed for textarea/input" is
// realized here only for <textarea> — an <input>-capable adapter doesn't
// exist yet (session.ts is built directly on createTextareaAdapter), so an
// <input> is deliberately kept ineligible until that adapter lands, rather
// than detected now and silently unable to mark/replace anything.
export const MIN_FIELD_WIDTH = 120
export const MIN_FIELD_HEIGHT = 40

/** Visible, enabled, writable <textarea> at least MIN_* in rendered size. */
export function isEligibleField(el: EventTarget | null): el is HTMLTextAreaElement {
  if (!(el instanceof HTMLTextAreaElement)) return false
  if (el.disabled || el.readOnly) return false
  const rect = el.getBoundingClientRect()
  return rect.width >= MIN_FIELD_WIDTH && rect.height >= MIN_FIELD_HEIGHT
}
