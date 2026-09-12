// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildSegmentMap, offsetAt, rangeFor, resolvePoint } from './segmentMap'

function rootWith(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('buildSegmentMap', () => {
  it('extracts plain text with no markup verbatim', () => {
    const map = buildSegmentMap(rootWith('hello world'))
    expect(map.text).toBe('hello world')
    expect(map.segments).toHaveLength(1)
    expect(map.segments[0].start).toBe(0)
  })

  it('flattens inline markup without separators', () => {
    const map = buildSegmentMap(rootWith('a <strong>bold <em>nest</em></strong> z'))
    expect(map.text).toBe('a bold nest z')
    // four text nodes: 'a ', 'bold ', 'nest', ' z'
    expect(map.segments.map((s) => s.start)).toEqual([0, 2, 7, 11])
  })

  it('synthesizes one newline per block boundary, collapsed, no leading/trailing', () => {
    expect(buildSegmentMap(rootWith('<div>line1</div><div>line2</div>')).text).toBe('line1\nline2')
    expect(buildSegmentMap(rootWith('a<p>b</p>c')).text).toBe('a\nb\nc')
    // consecutive/empty blocks collapse to a single separator
    expect(buildSegmentMap(rootWith('<div>a</div><div></div><div>b</div>')).text).toBe('a\nb')
  })

  it('emits a newline per inline <br>; a block-trailing <br> is boundary-only', () => {
    expect(buildSegmentMap(rootWith('a<br>b')).text).toBe('a\nb')
    // Chrome's blank line (<div><br></div>, what Enter-Enter produces in a
    // plain contentEditable) renders as ONE empty line: the block-trailing
    // <br> flushes the pending boundary but adds no newline of its own
    expect(buildSegmentMap(rootWith('<div>a</div><div><br></div><div>b</div>')).text).toBe('a\n\nb')
    // trailing filler <br> inside a block contributes nothing extra
    expect(buildSegmentMap(rootWith('<div>a<br></div><div>b</div>')).text).toBe('a\nb')
    expect(buildSegmentMap(rootWith('a<br>')).text).toBe('a')
    // leading <br> is content: it renders a blank first line
    expect(buildSegmentMap(rootWith('<br>a')).text).toBe('\na')
  })

  it('skips whitespace-only text nodes at block boundaries, keeps inline spaces', () => {
    // pretty-printed host markup (CMS composers, quoted replies)
    expect(buildSegmentMap(rootWith('<div>\n  <p>a</p>\n  <p>b</p>\n</div>')).text).toBe('a\nb')
    // a real inter-word space between inline elements is text
    expect(buildSegmentMap(rootWith('<em>a</em> <em>b</em>')).text).toBe('a b')
  })

  it('skips script/style/noscript/template subtrees', () => {
    const map = buildSegmentMap(rootWith('a<style>.x{}</style><script>1</script>b'))
    expect(map.text).toBe('ab')
  })

  it('keeps UTF-16 units: an astral char counts 2', () => {
    const map = buildSegmentMap(rootWith('x𝄞y'))
    expect(map.text).toBe('x𝄞y')
    expect(map.text.length).toBe(4)
  })
})

describe('resolvePoint / rangeFor', () => {
  it('resolves offsets inside a text node for both biases', () => {
    const root = rootWith('abc')
    const map = buildSegmentMap(root)
    expect(resolvePoint(map, 1, 'start')).toEqual({ node: map.segments[0].node, offset: 1 })
    expect(resolvePoint(map, 1, 'end')).toEqual({ node: map.segments[0].node, offset: 1 })
  })

  it('snaps a start on a synthetic newline forward, an end backward', () => {
    const root = rootWith('<div>ab</div><div>cd</div>') // "ab\ncd", '\n' at offset 2
    const map = buildSegmentMap(root)
    const start = resolvePoint(map, 2, 'start')
    expect(start?.node.data).toBe('cd')
    expect(start?.offset).toBe(0)
    const end = resolvePoint(map, 3, 'end') // to=3 ends just past the newline
    expect(end?.node.data).toBe('ab')
    expect(end?.offset).toBe(2)
  })

  it('rangeFor spans across block boundaries', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const map = buildSegmentMap(root)
    const range = rangeFor(map, 1, 4) // "b\nc"
    expect(range).not.toBeNull()
    expect(range?.startContainer.textContent).toBe('ab')
    expect(range?.startOffset).toBe(1)
    expect(range?.endContainer.textContent).toBe('cd')
    expect(range?.endOffset).toBe(1)
  })

  it('rangeFor refuses empty and synthetic-only spans', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const map = buildSegmentMap(root)
    expect(rangeFor(map, 2, 2)).toBeNull()
    expect(rangeFor(map, 2, 3)).toBeNull() // the '\n' alone: start snaps past end
  })
})

describe('offsetAt', () => {
  it('maps a text-node caret to its flat offset, clamped to node length', () => {
    const root = rootWith('a <strong>bb</strong> c')
    const map = buildSegmentMap(root) // "a bb c"
    const bb = map.segments[1].node
    expect(offsetAt(map, bb, 1)).toBe(3)
    expect(offsetAt(map, bb, 99)).toBe(4)
  })

  it('maps an element caret to the nearest following text position', () => {
    const root = rootWith('<div>ab</div><div>cd</div>')
    const map = buildSegmentMap(root)
    // caret "before child index 1" of root = between the two divs -> start of 'cd'
    expect(offsetAt(map, root, 1)).toBe(3)
    // caret after the last child -> end of text
    expect(offsetAt(map, root, 2)).toBe(5)
  })
})
