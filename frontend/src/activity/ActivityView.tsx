// Sixth activeView (B40, #124): per-user and all-users activity charts. See
// docs/frontend-architecture.md's "Activity view" section for the subject
// model this component reads from the store.
import { useEffect, useState } from 'react'
import {
  getAllActivity,
  getOwnActivity,
  getUserActivity,
  type ActivityDays,
  type ActivityResponse,
  type PerUserActivity,
} from '../api/client'
import { useMessages, type Messages } from '../i18n'
import { useStore } from '../state/store'
import { StackedBarChart, type ChartSeries } from './StackedBarChart'

const DAY_OPTIONS: ActivityDays[] = [30, 90, 365]

type SortKey = 'user' | 'runs' | 'input_tokens' | 'output_tokens' | 'credits'
type SortDir = 'asc' | 'desc'

const SORT_VALUE: Record<SortKey, (row: PerUserActivity) => string | number> = {
  user: (row) => row.display_name ?? row.email,
  runs: (row) => row.runs,
  input_tokens: (row) => row.input_tokens,
  output_tokens: (row) => row.output_tokens,
  credits: (row) => row.credits,
}

function sortRows(rows: PerUserActivity[], key: SortKey, dir: SortDir): PerUserActivity[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = SORT_VALUE[key](a)
    const bv = SORT_VALUE[key](b)
    return typeof av === 'number' && typeof bv === 'number'
      ? factor * (av - bv)
      : factor * String(av).localeCompare(String(bv))
  })
}

function rangeLabel(days: ActivityDays, m: Messages): string {
  if (days === 30) return m.activityDays30
  if (days === 90) return m.activityDays90
  return m.activityDays365
}

export function ActivityView() {
  const user = useStore((s) => s.user)
  const activitySubject = useStore((s) => s.activitySubject)
  const activitySubjectLabel = useStore((s) => s.activitySubjectLabel)
  const setActivitySubject = useStore((s) => s.setActivitySubject)
  const m = useMessages()

  // Client-side gate: a non-admin's effective subject is always its own,
  // regardless of whatever numeric/'all' value the store carries (e.g. left
  // over from a since-revoked admin session) — see the non-admin test.
  const effectiveSubject = user?.is_admin ? activitySubject : 'self'

  const [days, setDays] = useState<ActivityDays>(30)
  const [data, setData] = useState<ActivityResponse | null>(null)
  const [error, setError] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('credits')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    setData(null)
    setError(false)
    let cancelled = false
    const call =
      effectiveSubject === 'self'
        ? getOwnActivity(days)
        : effectiveSubject === 'all'
          ? getAllActivity(days)
          : getUserActivity(effectiveSubject, days)
    call
      .then((response) => {
        if (!cancelled) setData(response)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveSubject, days])

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  function openUser(row: PerUserActivity) {
    setActivitySubject(row.user_id, row.display_name ?? row.email)
  }

  // A numeric subject only ever arises by drilling into a row from the
  // all-users table below, so its mere presence already implies "came from
  // 'all'" — there is no other path to a numeric subject in this view.
  const showBack = typeof effectiveSubject === 'number'

  // A numeric subject only ever arrives via openUser(), which always passes
  // a label (display_name ?? email) — the subject itself is never
  // persisted/reloaded with a bare id, so activitySubjectLabel is never
  // null here.
  const heading =
    effectiveSubject === 'self'
      ? m.accountActivity
      : effectiveSubject === 'all'
        ? m.activityTitleAll
        : activitySubjectLabel

  // `?? []` guards each category: the runs dict is the extension point
  // (see usage.py's activity_series comment) — a category missing or
  // renamed server-side should render as zeros, not throw mid-render.
  const runSeries: ChartSeries[] = data
    ? [
        { key: 'check', label: m.activityCheck, cssVar: '--accent', values: data.series.runs.check ?? [] },
        { key: 'suggestion', label: m.activitySuggestion, cssVar: '--accent-mid', values: data.series.runs.suggestion ?? [] },
        { key: 'name', label: m.activityName, cssVar: '--accent-faint', values: data.series.runs.name ?? [] },
        { key: 'failed', label: m.activityFailed, cssVar: '--held-back', values: data.series.runs.failed ?? [] },
      ]
    : []
  const tokenSeries: ChartSeries[] = data
    ? [
        { key: 'input', label: m.activityInput, cssVar: '--accent', values: data.series.input_tokens },
        { key: 'output', label: m.activityOutput, cssVar: '--accent-faint', values: data.series.output_tokens },
      ]
    : []
  const creditSeries: ChartSeries[] = data
    ? [{ key: 'credits', label: m.activityTableCredits, cssVar: '--accent-mid', values: data.series.credits }]
    : []

  const rows =
    effectiveSubject === 'all' && data?.per_user ? sortRows(data.per_user, sortKey, sortDir) : null

  return (
    <div className="activity-view">
      <div className="activity-header">
        <h2>{heading}</h2>
        <div className="activity-range-picker">
          {DAY_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={option === days ? 'active' : ''}
              aria-pressed={option === days}
              onClick={() => setDays(option)}
            >
              {rangeLabel(option, m)}
            </button>
          ))}
        </div>
      </div>
      {showBack && (
        <button type="button" className="activity-back" onClick={() => setActivitySubject('all')}>
          {m.activityBack}
        </button>
      )}
      {error && (
        <p className="activity-error" role="alert">
          {m.activityLoadError}
        </p>
      )}
      {!error && !data && (
        <p className="activity-loading" role="status">
          {m.activityLoading}
        </p>
      )}
      {!error && data && (
        <>
          <p className="activity-totals">
            {`${data.totals.runs} ${m.activityTotalRuns} · ${data.totals.input_tokens} ${m.activityInput} / ${data.totals.output_tokens} ${m.activityOutput} · ${data.totals.credits} ${m.activityTableCredits}`}
          </p>
          <div className="activity-panel">
            <div className="activity-panel-label">{m.activityRuns}</div>
            <StackedBarChart days={data.days} series={runSeries} ariaLabel={m.activityRuns} />
          </div>
          <div className="activity-panel">
            <div className="activity-panel-label">{m.activityTokens}</div>
            <StackedBarChart days={data.days} series={tokenSeries} ariaLabel={m.activityTokens} />
          </div>
          <div className="activity-panel">
            <div className="activity-panel-label">{m.activityCredits}</div>
            <StackedBarChart days={data.days} series={creditSeries} ariaLabel={m.activityCredits} />
          </div>
          {rows && (
            <table className="activity-table">
              <thead>
                <tr>
                  <th>
                    <button type="button" onClick={() => toggleSort('user')}>
                      {m.activityTableUser}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => toggleSort('runs')}>
                      {m.activityTotalRuns}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => toggleSort('input_tokens')}>
                      {m.activityInput}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => toggleSort('output_tokens')}>
                      {m.activityOutput}
                    </button>
                  </th>
                  <th>
                    <button type="button" onClick={() => toggleSort('credits')}>
                      {m.activityTableCredits}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user_id}>
                    <td>
                      <button type="button" onClick={() => openUser(row)}>
                        {row.display_name ?? row.email}
                      </button>
                    </td>
                    <td>{row.runs}</td>
                    <td>{row.input_tokens}</td>
                    <td>{row.output_tokens}</td>
                    <td>{row.credits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
