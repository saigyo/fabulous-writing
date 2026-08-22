// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StackedBarChart, type ChartSeries } from './StackedBarChart'

afterEach(cleanup)

const DAYS = ['2026-08-18', '2026-08-19', '2026-08-20']

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
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" />,
    )
    // day0: 0 segs, day1: check=1 (1 seg), day2: check=2 + failed=1 (2 segs)
    expect(container.querySelectorAll('rect.chart-seg').length).toBe(3)
  })

  it('renders exactly one chart-hit and one title per day, with day and non-zero label/value pairs', () => {
    const { container } = render(
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" />,
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
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" />,
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
      <StackedBarChart days={DAYS} series={allZeroSeries(DAYS)} ariaLabel="Activity" />,
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
      <StackedBarChart days={DAYS} series={threeDaySeries()} ariaLabel="Activity" />,
    )
    expect(container.querySelectorAll('line.chart-grid').length).toBe(3)
  })

  it('thins x-axis labels to at most 8 for a 30-day range', () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-01`)
    const series: ChartSeries[] = [
      { key: 'check', label: 'check', cssVar: '--accent', values: days.map((_, i) => i) },
    ]
    const { container } = render(
      <StackedBarChart days={days} series={series} ariaLabel="Activity" />,
    )
    const labels = container.querySelectorAll('text.chart-xlabel')
    expect(labels.length).toBeLessThanOrEqual(8)
  })
})
