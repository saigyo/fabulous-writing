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
import { sessionGeneration } from '../auth/session'
import { useLocale, useMessages, type Messages } from '../i18n'
import { useStore } from '../state/store'
import { formatDay } from './formatDay'
import { StackedBarChart, type ChartSeries } from './StackedBarChart'

const DAY_OPTIONS: ActivityDays[] = [30, 90, 365]

type SortKey = 'user' | 'runs' | 'input_tokens' | 'output_tokens' | 'credits'
type SortDir = 'asc' | 'desc'

// display_name can be empty/whitespace through the admin API (AdminUserPatch
// allows any string) — `??` alone treats "" as a usable value, showing (and
// sorting/labeling by) a blank instead of falling through to the email.
function userLabel(row: PerUserActivity): string {
  return row.display_name?.trim() || row.email
}

const SORT_VALUE: Record<SortKey, (row: PerUserActivity) => string | number> = {
  user: userLabel,
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

// aria-sort belongs on the <th>, not the button inside it — the column
// header element is what screen readers report sort state for.
function sortAriaValue(key: SortKey, activeKey: SortKey, dir: SortDir): 'ascending' | 'descending' | 'none' {
  if (key !== activeKey) return 'none'
  return dir === 'asc' ? 'ascending' : 'descending'
}

export function ActivityView() {
  const user = useStore((s) => s.user)
  const activitySubject = useStore((s) => s.activitySubject)
  const activitySubjectLabel = useStore((s) => s.activitySubjectLabel)
  const setActivitySubject = useStore((s) => s.setActivitySubject)
  // Bumped only by login()'s commit (see its own comment in state/store.ts)
  // — including the silent same-user re-login the password-change flow
  // performs (auth/AccountMenu.tsx). Depending on it below re-fires the
  // fetch effect on that re-login, so a request still in flight at that
  // moment gets a replacement instead of the view being stuck showing the
  // outgoing session's numbers — same mechanism as App.tsx's Header domains
  // fetch and TerminologyView's refreshDomains.
  const authGeneration = useStore((s) => s.authGeneration)
  const m = useMessages()
  // Binds the current UI locale into a pure iso-day -> display-string
  // function, so StackedBarChart itself stays locale-agnostic (formatDay.ts
  // does the actual Intl.DateTimeFormat work; see its own timezone-trap
  // comment).
  const locale = useLocale()
  const formatChartDay = (iso: string) => formatDay(iso, locale)

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
    // `cancelled` closes the slow-old-request-overwrites-new race: a subject
    // or range switch (or unmount) must stop THIS invocation's response
    // from committing once a newer one has started, even though both share
    // the same sessionGeneration() (a subject/range change is not a session
    // turnover, so that guard alone doesn't cover it).
    let cancelled = false
    const gen = sessionGeneration()
    const call =
      effectiveSubject === 'self'
        ? getOwnActivity(days)
        : effectiveSubject === 'all'
          ? getAllActivity(days)
          : getUserActivity(effectiveSubject, days)
    call
      .then((response) => {
        if (!cancelled && sessionGeneration() === gen) setData(response)
      })
      .catch(() => {
        if (!cancelled && sessionGeneration() === gen) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [effectiveSubject, days, authGeneration])

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // Visible complement to the aria-sort attribute below — a sighted user
  // gets the same signal a screen reader gets from the <th>.
  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  function openUser(row: PerUserActivity) {
    setActivitySubject(row.user_id, userLabel(row))
  }

  // A numeric subject only ever arises by drilling into a row from the
  // all-users table below, so its mere presence already implies "came from
  // 'all'" — there is no other path to a numeric subject in this view.
  const showBack = typeof effectiveSubject === 'number'

  // A numeric subject only ever arrives via openUser(), which always passes
  // a label (userLabel(row)) — the subject itself is never
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
            <StackedBarChart days={data.days} series={runSeries} ariaLabel={m.activityRuns} formatDay={formatChartDay} />
          </div>
          <div className="activity-panel">
            <div className="activity-panel-label">{m.activityTokens}</div>
            <StackedBarChart days={data.days} series={tokenSeries} ariaLabel={m.activityTokens} formatDay={formatChartDay} />
          </div>
          <div className="activity-panel">
            <div className="activity-panel-label">{m.activityCredits}</div>
            <StackedBarChart days={data.days} series={creditSeries} ariaLabel={m.activityCredits} formatDay={formatChartDay} />
          </div>
          {rows && (
            <table className="activity-table">
              <thead>
                <tr>
                  <th aria-sort={sortAriaValue('user', sortKey, sortDir)}>
                    <button type="button" onClick={() => toggleSort('user')}>
                      {m.activityTableUser}{sortIndicator('user')}
                    </button>
                  </th>
                  <th aria-sort={sortAriaValue('runs', sortKey, sortDir)}>
                    <button type="button" onClick={() => toggleSort('runs')}>
                      {m.activityTotalRuns}{sortIndicator('runs')}
                    </button>
                  </th>
                  <th aria-sort={sortAriaValue('input_tokens', sortKey, sortDir)}>
                    <button type="button" onClick={() => toggleSort('input_tokens')}>
                      {m.activityInput}{sortIndicator('input_tokens')}
                    </button>
                  </th>
                  <th aria-sort={sortAriaValue('output_tokens', sortKey, sortDir)}>
                    <button type="button" onClick={() => toggleSort('output_tokens')}>
                      {m.activityOutput}{sortIndicator('output_tokens')}
                    </button>
                  </th>
                  <th aria-sort={sortAriaValue('credits', sortKey, sortDir)}>
                    <button type="button" onClick={() => toggleSort('credits')}>
                      {m.activityTableCredits}{sortIndicator('credits')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user_id}>
                    <td>
                      <button type="button" onClick={() => openUser(row)}>
                        {userLabel(row)}
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
