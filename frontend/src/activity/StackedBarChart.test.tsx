// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StackedBarChart, type ChartSeries } from './StackedBarChart'

afterEach(cleanup)

const DAYS = ['2026-08-18', '2026-08-19', '2026-08-20']

// Every existing test predates the formatDay prop and asserts on the raw
// ISO strings — the identity function keeps their assertions meaningful
// without rewriting them for locale formatting they don't care about.
const identityFormatDay = (iso: string) => iso

function threeDaySeries(): ChartSeries[] {
  return [
    { key: 'check', label: 'check', cssVar: '--accent', values: [0, 1, 2] },
    { key: 'failed', label: 'failed', cssVar: '--accent-mid', values: [0, 0, 1] },
  ]
}

function allZeroSeries(days: string[]): ChartSeries[] {
  return [
    { key: 'check', label: 'check', cssVar: '--accent', values: days.map(() => 0) },
    { key: 'failed', label: 'failed', cssVar: '--accent-mid', values: days.map(() => 0) },
  ]
}

describe('StackedBarChart', () => {
  it('renders one chart-seg per non-zero segment', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    // day0: 0 segs, day1: check=1 (1 seg), day2: check=2 + failed=1 (2 segs)
    expect(container.querySelectorAll('rect.chart-seg').length).toBe(3)
  })

  it('renders exactly one chart-hit and one title per day, with day and non-zero label/value pairs', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    expect(container.querySelectorAll('rect.chart-hit').length).toBe(DAYS.length)
    const titles = container.querySelectorAll('title')
    expect(titles.length).toBe(DAYS.length)
    const lastTitle = titles[titles.length - 1].textContent ?? ''
    expect(lastTitle).toContain('2026-08-20')
    expect(lastTitle).toContain('check 2')
    expect(lastTitle).toContain('failed 1')
  })

  it('gives a zero-value day its chart-hit and title but no chart-seg', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    const dayGroups = container.querySelectorAll('svg > g')
    expect(dayGroups.length).toBe(DAYS.length)
    const zeroDay = dayGroups[0]
    expect(zeroDay.querySelectorAll('rect.chart-seg').length).toBe(0)
    expect(zeroDay.querySelectorAll('rect.chart-hit').length).toBe(1)
    const title = zeroDay.querySelector('title')
    expect(title).not.toBeNull()
    expect(title?.textContent).toBe('2026-08-18')
  })

  it('renders real axes (gridlines + hit rects, non-zero max tick) for an all-zero fixture', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={allZeroSeries(DAYS)} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    expect(container.querySelector('svg.activity-chart')).not.toBeNull()
    expect(container.querySelectorAll('line.chart-grid').length).toBe(3)
    expect(container.querySelectorAll('rect.chart-hit').length).toBe(DAYS.length)
    expect(container.querySelectorAll('rect.chart-seg').length).toBe(0)
    const yticks = container.querySelectorAll('text.chart-ytick')
    expect(yticks.length).toBe(2)
    // The fallback-to-1 max keeps this "1", not "0" — see the y-max mutation
    // check.
    expect(yticks[1].textContent).toBe('1')
  })

  it('renders exactly 3 gridlines regardless of day count', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    expect(container.querySelectorAll('line.chart-grid').length).toBe(3)
  })

  it('thins x-axis labels to at most 8 for a 30-day range', () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-01`)
    const series: ChartSeries[] = [
      { key: 'check', label: 'check', cssVar: '--accent', values: days.map((_, i) => i) },
    ]
    const { container } = render(
      <StackedBarChart days={days} series={series} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    const labels = container.querySelectorAll('text.chart-xlabel')
    expect(labels.length).toBeLessThanOrEqual(8)
  })

  it('renders one x-axis tick mark per labeled date', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    const ticks = container.querySelectorAll('line.chart-tick')
    const labels = container.querySelectorAll('text.chart-xlabel')
    expect(ticks.length).toBe(labels.length)
  })

  it('anchors the first x-label at its slot start and the last at the plot right edge, so the rightmost date is never clipped', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={identityFormatDay} />,
    )
    const labels = container.querySelectorAll('text.chart-xlabel')
    expect(labels[0].getAttribute('text-anchor')).toBe('start')
    expect(labels[labels.length - 1].getAttribute('text-anchor')).toBe('end')
  })

  describe('formatDay prop', () => {
    // A formatter distinguishable from the raw ISO string on sight, so a
    // regression that bypasses it (renders the iso day directly) is caught
    // even though its input/output overlap in structure.
    const fakeFormatDay = (iso: string) => `FMT[${iso}]`

    it('renders x-axis labels through the given formatDay function, not the raw ISO string', () => {
      const { container } = render(
        <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={fakeFormatDay} />,
      )
      const labels = container.querySelectorAll('text.chart-xlabel')
      expect(labels.length).toBeGreaterThan(0)
      for (const label of labels) {
        expect(label.textContent).toMatch(/^FMT\[2026-08-\d\d\]$/)
      }
    })

    it('renders the tooltip day prefix through the given formatDay function', () => {
      const { container } = render(
        <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" formatDay={fakeFormatDay} />,
      )
      const titles = container.querySelectorAll('title')
      const lastTitle = titles[titles.length - 1].textContent ?? ''
      expect(lastTitle).toContain('FMT[2026-08-20]')
      expect(lastTitle).not.toContain('2026-08-20 —') // raw iso must not leak through unformatted
    })
  })
})
