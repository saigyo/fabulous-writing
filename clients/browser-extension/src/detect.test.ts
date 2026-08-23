import { describe, expect, it } from 'vitest'
import { isEligibleField, MIN_FIELD_HEIGHT, MIN_FIELD_WIDTH } from './detect'

function stubRect(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = () => ({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
    toJSON() { return {} },
  })
}

function eligibleTextarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  stubRect(el, MIN_FIELD_WIDTH + 80, MIN_FIELD_HEIGHT + 40)
  return el
}

describe('isEligibleField', () => {
  it('accepts a visible, enabled, writable textarea at least MIN_FIELD_WIDTH x MIN_FIELD_HEIGHT', () => {
    expect(isEligibleField(eligibleTextarea())).toBe(true)
  })

  it('rejects an <input type="text"> — v1 detection is textarea-only', () => {
    const el = document.createElement('input')
    el.type = 'text'
    document.body.appendChild(el)
    stubRect(el, 200, 80)
    expect(isEligibleField(el)).toBe(false)
  })

  it('rejects a disabled textarea', () => {
    const el = eligibleTextarea()
    el.disabled = true
    expect(isEligibleField(el)).toBe(false)
  })

  it('rejects a readOnly textarea', () => {
    const el = eligibleTextarea()
    el.readOnly = true
    expect(isEligibleField(el)).toBe(false)
  })

  it('rejects a textarea shorter than MIN_FIELD_HEIGHT (200x20)', () => {
    const el = document.createElement('textarea')
    document.body.appendChild(el)
    stubRect(el, 200, 20)
    expect(isEligibleField(el)).toBe(false)
  })

  it('rejects a display:none textarea (0x0 rect)', () => {
    const el = document.createElement('textarea')
    document.body.appendChild(el)
    stubRect(el, 0, 0)
    expect(isEligibleField(el)).toBe(false)
  })

  it('rejects a non-element target', () => {
    expect(isEligibleField(null)).toBe(false)
    expect(isEligibleField(window)).toBe(false)
    const div = document.createElement('div')
    document.body.appendChild(div)
    stubRect(div, 200, 80)
    expect(isEligibleField(div)).toBe(false)
  })
})
