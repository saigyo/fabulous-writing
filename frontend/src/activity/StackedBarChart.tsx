// Pure SVG stacked-bar chart for the activity view (B40, #124). No state —
// every pixel is derived from props on each render.

export interface ChartSeries {
  key: string
  label: string
  cssVar: string
  values: number[]
}

const VIEWBOX_W = 720
const VIEWBOX_H = 160
const PAD_LEFT = 44
const PAD_BOTTOM = 18
const PAD_TOP = 8
const PAD_RIGHT = 8
const GRID_TICKS = 3

// 0, ceil(n/6), 2*ceil(n/6), ... always ending on n-1, so a wide day range
// (30/90/365) never crowds the x-axis with unreadable labels.
function thinnedIndices(n: number): number[] {
  if (n === 0) return []
  const step = Math.ceil(n / 6)
  const indices: number[] = []
  for (let i = 0; i < n - 1; i += step) indices.push(i)
  indices.push(n - 1)
  return indices
}

export function StackedBarChart(props: {
  days: string[]
  series: ChartSeries[]
  ariaLabel: string
}) {
  const { days, series, ariaLabel } = props

  const plotLeft = PAD_LEFT
  const plotRight = VIEWBOX_W - PAD_RIGHT
  const plotTop = PAD_TOP
  const plotBottom = VIEWBOX_H - PAD_BOTTOM
  const plotWidth = plotRight - plotLeft
  const plotHeight = plotBottom - plotTop

  const dayTotals = days.map((_, i) =>
    series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  )
  const rawMax = dayTotals.length ? Math.max(...dayTotals) : 0
  // Fallback to 1 keeps an all-zero response rendering real axes (a "1" max
  // tick) instead of a 0/0 axis — see mutation check in the test file.
  const yMax = rawMax > 0 ? rawMax : 1

  const barSlot = days.length ? plotWidth / days.length : plotWidth
  const segGap = Math.min(2, barSlot * 0.1)
  const segWidth = Math.max(barSlot - segGap * 2, 1)

  const gridLines = Array.from({ length: GRID_TICKS }, (_, i) => {
    const k = i + 1
    return plotBottom - (k / GRID_TICKS) * plotHeight
  })

  const xLabelIndices = thinnedIndices(days.length)

  return (
    <svg
      className="activity-chart"
      viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
      role="img"
      aria-label={ariaLabel}
    >
      {gridLines.map((y, i) => (
        <line
          key={`grid-${i}`}
          className="chart-grid"
          x1={plotLeft}
          x2={plotRight}
          y1={y}
          y2={y}
          stroke="var(--border)"
        />
      ))}
      <line
        className="chart-baseline"
        x1={plotLeft}
        x2={plotRight}
        y1={plotBottom}
        y2={plotBottom}
        stroke="var(--border)"
      />
      <text
        className="chart-ytick"
        x={plotLeft - 6}
        y={plotBottom}
        textAnchor="end"
        fill="var(--text-dim)"
        fontSize={10}
      >
        0
      </text>
      <text
        className="chart-ytick"
        x={plotLeft - 6}
        y={plotTop + 8}
        textAnchor="end"
        fill="var(--text-dim)"
        fontSize={10}
      >
        {yMax}
      </text>
      {days.map((day, i) => {
        const nonZero = series
          .map((s) => ({ label: s.label, cssVar: s.cssVar, value: s.values[i] ?? 0 }))
          .filter((e) => e.value > 0)
        const title =
          nonZero.length === 0
            ? day
            : `${day} — ${nonZero.map((e) => `${e.label} ${e.value}`).join(', ')}`
        const segX = plotLeft + i * barSlot + segGap
        let cursorY = plotBottom
        return (
          <g key={day}>
            {nonZero.map((e) => {
              const height = (e.value / yMax) * plotHeight
              cursorY -= height
              return (
                <rect
                  key={e.label}
                  className="chart-seg"
                  x={segX}
                  y={cursorY}
                  width={segWidth}
                  height={height}
                  fill={`var(${e.cssVar})`}
                />
              )
            })}
            <rect
              className="chart-hit"
              x={plotLeft + i * barSlot}
              y={plotTop}
              width={barSlot}
              height={plotHeight}
              fill="transparent"
            >
              <title>{title}</title>
            </rect>
          </g>
        )
      })}
      {xLabelIndices.map((i) => (
        <text
          key={i}
          className="chart-xlabel"
          x={plotLeft + i * barSlot + barSlot / 2}
          y={VIEWBOX_H - 4}
          textAnchor="middle"
        >
          {days[i]}
        </text>
      ))}
    </svg>
  )
}
