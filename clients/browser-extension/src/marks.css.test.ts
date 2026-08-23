// Copilot round 2 (B43 C2), S6a: every MARKS_CSS rule must be scoped under
// `[data-fw-overlay]` (the attribute textareaAdapter.ts sets on the mirror
// overlay it creates) rather than a bare `.fw-mark*` class selector — a host
// page's own CSS could otherwise restyle any element it happens to give one
// of these (plausibly-colliding) class names via this global stylesheet
// (scout.ts injects MARKS_CSS into the host page's own document.head).
import { describe, expect, it } from 'vitest'
import { MARKS_CSS } from './marks.css'

describe('MARKS_CSS', () => {
  it('scopes every rule under the [data-fw-overlay] attribute selector', () => {
    // Split on the rule terminator ('}') rather than matching up to the next
    // '{': MARKS_CSS is multi-rule, so a greedy "everything up to a brace"
    // regex spans past a rule's own closing brace into the FOLLOWING rule's
    // declarations, which are not selector text at all.
    const blocks = MARKS_CSS.split('}').map((b) => b.trim()).filter(Boolean)
    const selectors = blocks.map((b) => b.slice(0, b.indexOf('{')).trim())
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector.startsWith('[data-fw-overlay] ')).toBe(true)
    }
  })

  it('still defines a rule for each fw-mark class the adapter renders', () => {
    expect(MARKS_CSS).toContain('[data-fw-overlay] .fw-mark {')
    expect(MARKS_CSS).toContain('[data-fw-overlay] .fw-mark-error {')
    expect(MARKS_CSS).toContain('[data-fw-overlay] .fw-mark-warning {')
    expect(MARKS_CSS).toContain('[data-fw-overlay] .fw-mark-suggestion {')
    expect(MARKS_CSS).toContain('[data-fw-overlay] .fw-mark-flash {')
  })

  // Copilot round 3, S3: severity fills must be translucent (rgba, not an
  // opaque hex) so a dark host page's background (GitHub dark mode, the
  // acceptance benchmark) keeps providing contrast against the field's own
  // light foreground text underneath — an opaque pastel fill hides it.
  it('uses translucent rgba fills for every severity, not opaque hex', () => {
    expect(MARKS_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(MARKS_CSS).toContain('background: rgba(248, 180, 180, 0.35);')
    expect(MARKS_CSS).toContain('background: rgba(253, 230, 138, 0.35);')
    expect(MARKS_CSS).toContain('background: rgba(191, 219, 254, 0.35);')
    expect(MARKS_CSS).toContain('outline: 2px solid rgba(110, 86, 207, 0.9);')
  })
})
