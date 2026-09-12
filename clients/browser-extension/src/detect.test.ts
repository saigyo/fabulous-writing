import { describe, expect, it } from 'vitest'
import { fieldKindOf, isEligibleField, MIN_FIELD_HEIGHT, MIN_FIELD_WIDTH, resolveEligibleField } from './detect'

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

function eligibleHost(): HTMLDivElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  document.body.appendChild(el)
  stubRect(el, MIN_FIELD_WIDTH + 80, MIN_FIELD_HEIGHT + 40)
  return el
}

describe('isEligibleField', () => {
  it('accepts a visible, enabled, writable textarea at least MIN_FIELD_WIDTH x MIN_FIELD_HEIGHT', () => {
    expect(isEligibleField(eligibleTextarea())).toBe(true)
  })

  it('rejects an <input type="text"> — no input-capable adapter exists yet', () => {
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

  it('rejects a textarea inside a disabled fieldset', () => {
    const fieldset = document.createElement('fieldset')
    fieldset.disabled = true
    const el = document.createElement('textarea')
    fieldset.appendChild(el)
    document.body.appendChild(fieldset)
    stubRect(el, MIN_FIELD_WIDTH + 80, MIN_FIELD_HEIGHT + 40)
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

describe('contentEditable eligibility', () => {
  it('accepts an editing host (contenteditable="true", parent not editable, ≥ min size); fieldKindOf → contenteditable', () => {
    const host = eligibleHost()
    expect(isEligibleField(host)).toBe(true)
    expect(fieldKindOf(host)).toBe('contenteditable')
  })

  it('rejects an inner child of an editing host directly, but resolveEligibleField climbs to the host root', () => {
    const host = eligibleHost()
    const span = document.createElement('span')
    span.textContent = 'inner'
    host.appendChild(span)
    expect(isEligibleField(span)).toBe(false)
    expect(resolveEligibleField(span)).toBe(host)
  })

  it('rejects contenteditable="false"', () => {
    const el = document.createElement('div')
    el.contentEditable = 'false'
    document.body.appendChild(el)
    stubRect(el, MIN_FIELD_WIDTH + 80, MIN_FIELD_HEIGHT + 40)
    expect(isEligibleField(el)).toBe(false)
  })

  it('resolveEligibleField climbs past a contenteditable="false" island (a mention chip, a link card) to the enclosing host root', () => {
    const host = eligibleHost()
    const island = document.createElement('span')
    island.contentEditable = 'false'
    island.textContent = '@mention'
    host.appendChild(island)
    expect(isEligibleField(island)).toBe(false)
    expect(resolveEligibleField(island)).toBe(host)
  })

  it('rejects a nested editing host whose parent is also editable; resolveEligibleField climbs to the outermost editable ancestor', () => {
    const outer = eligibleHost()
    const inner = document.createElement('div')
    inner.contentEditable = 'true'
    outer.appendChild(inner)
    stubRect(inner, MIN_FIELD_WIDTH + 80, MIN_FIELD_HEIGHT + 40)
    expect(isEligibleField(inner)).toBe(false)
    expect(resolveEligibleField(inner)).toBe(outer)
  })

  it('rejects a contenteditable host smaller than MIN_FIELD_WIDTH x MIN_FIELD_HEIGHT', () => {
    const el = document.createElement('div')
    el.contentEditable = 'true'
    document.body.appendChild(el)
    stubRect(el, 50, 20)
    expect(isEligibleField(el)).toBe(false)
  })
})

describe('fieldKindOf and resolveEligibleField for textarea', () => {
  it('fieldKindOf(textarea) returns textarea; existing textarea eligibility unchanged', () => {
    const el = eligibleTextarea()
    expect(isEligibleField(el)).toBe(true)
    expect(fieldKindOf(el)).toBe('textarea')
  })

  it('resolveEligibleField returns an eligible textarea as-is, and null for null/body', () => {
    const el = eligibleTextarea()
    expect(resolveEligibleField(el)).toBe(el)
    expect(resolveEligibleField(null)).toBeNull()
    expect(resolveEligibleField(document.body)).toBeNull()
  })

  it('resolveEligibleField returns null for a plain non-editable element with no editable ancestor', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    stubRect(div, 200, 80)
    expect(resolveEligibleField(div)).toBeNull()
  })
})
