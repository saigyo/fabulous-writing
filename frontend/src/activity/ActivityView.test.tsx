// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityResponse, MeResponse, PerUserActivity } from '../api/client'
import { de } from '../i18n/de'
import { en } from '../i18n/en'
import { useStore } from '../state/store'

// getOwnActivity/getAllActivity/getUserActivity are mocked; every other
// export stays real via the importOriginal spread — same idiom
// App.test.tsx/AdminView.test.tsx use.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getOwnActivity: vi.fn(),
  getAllActivity: vi.fn(),
  getUserActivity: vi.fn(),
}))

import { getAllActivity, getOwnActivity, getUserActivity } from '../api/client'
import { ActivityView } from './ActivityView'
import { formatDay } from './formatDay'

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 1,
    email: 'ada@example.com',
    display_name: null,
    tier: 'basic',
    is_admin: false,
    policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
    limits: {
      max_document_chars: 200000,
      max_llm_document_chars: 200000,
      concurrent_llm_runs: 5,
    },
    allow_additional_admins: false,
    db_backend: 'sqlite',
    ...overrides,
  }
}

function series(days: number, fill: number) {
  return Array.from({ length: days }, () => fill)
}

function selfFixture(): ActivityResponse {
  return {
    days: ['2026-07-24', '2026-07-25', '2026-07-26'],
    series: {
      runs: {
        check: [1, 2, 3],
        suggestion: [0, 1, 0],
        name: [0, 0, 1],
        failed: [0, 0, 0],
      },
      input_tokens: [100, 200, 300],
      output_tokens: [50, 100, 150],
      credits: [1, 2, 3],
    },
    totals: { runs: 8, input_tokens: 600, output_tokens: 300, credits: 6 },
    per_user: null,
  }
}

function perUserRow(overrides: Partial<PerUserActivity> = {}): PerUserActivity {
  return {
    user_id: 1,
    email: 'a@example.com',
    display_name: 'Ada',
    runs: 1,
    input_tokens: 5,
    output_tokens: 2,
    credits: 1,
    ...overrides,
  }
}

function allFixture(): ActivityResponse {
  return {
    days: ['2026-07-24', '2026-07-25'],
    series: {
      runs: { check: [1, 1], suggestion: [0, 0], name: [0, 0], failed: [0, 0] },
      input_tokens: [10, 10],
      output_tokens: [5, 5],
      credits: [2, 2],
    },
    totals: { runs: 2, input_tokens: 20, output_tokens: 10, credits: 4 },
    per_user: [
      perUserRow({ user_id: 1, email: 'ada@example.com', display_name: 'Ada', credits: 1 }),
      perUserRow({ user_id: 2, email: 'bea@example.com', display_name: 'Bea', credits: 9 }),
    ],
  }
}

function userActivityFixture(): ActivityResponse {
  return {
    days: ['2026-07-24', '2026-07-25'],
    series: {
      runs: { check: [1, 0], suggestion: [0, 0], name: [0, 0], failed: [0, 0] },
      input_tokens: [5, 0],
      output_tokens: [2, 0],
      credits: [1, 0],
    },
    totals: { runs: 1, input_tokens: 5, output_tokens: 2, credits: 1 },
    per_user: null,
  }
}

function zeroFixture(): ActivityResponse {
  const days = ['2026-07-24', '2026-07-25', '2026-07-26']
  return {
    days,
    series: {
      runs: { check: series(3, 0), suggestion: series(3, 0), name: series(3, 0), failed: series(3, 0) },
      input_tokens: series(3, 0),
      output_tokens: series(3, 0),
      credits: series(3, 0),
    },
    totals: { runs: 0, input_tokens: 0, output_tokens: 0, credits: 0 },
    per_user: null,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    uiLocale: 'en',
    user: user(),
    activitySubject: 'self',
    activitySubjectLabel: null,
  })
})

describe('ActivityView: self subject', () => {
  it('fetches own activity, renders panels and totals; a range click refetches', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(selfFixture())

    render(<ActivityView />)

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(30))
    await screen.findByText(en.activityRuns, { selector: '.activity-panel-label' })
    screen.getByText(en.activityTokens, { selector: '.activity-panel-label' })
    screen.getByText(en.activityCredits, { selector: '.activity-panel-label' })
    screen.getByText(
      `8 ${en.activityTotalRuns} · 600 ${en.activityInput} / 300 ${en.activityOutput} · 6 ${en.activityTableCredits}`,
    )

    vi.mocked(getOwnActivity).mockResolvedValue({ ...selfFixture(), totals: { runs: 1, input_tokens: 1, output_tokens: 1, credits: 1 } })
    fireEvent.click(screen.getByRole('button', { name: en.activityDays90 }))
    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(90))
  })
})

describe('ActivityView: non-admin client-side gate', () => {
  it('a non-admin session, even with the store subject forced to "all", still fetches its own data and renders no table or back control', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(selfFixture())
    useStore.setState({ user: user({ is_admin: false }), activitySubject: 'all' })

    const { container } = render(<ActivityView />)

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(30))
    expect(getAllActivity).not.toHaveBeenCalled()
    await screen.findByText(en.activityRuns, { selector: '.activity-panel-label' })
    // Every panel's visually-hidden SR data table still renders regardless
    // of subject — only the sortable ALL-USERS table (`.activity-table`) is
    // gated, so that's the one to assert absent here.
    expect(container.querySelector('table.activity-table')).toBeNull()
    expect(screen.queryByText(en.activityBack)).toBeNull()
  })
})

describe('ActivityView: admin, all-users subject', () => {
  it('fetches all-users activity, renders sortable table rows, drills into a user, and returns via back', async () => {
    vi.mocked(getAllActivity).mockResolvedValue(allFixture())
    vi.mocked(getUserActivity).mockResolvedValue(userActivityFixture())
    useStore.setState({ user: user({ is_admin: true }), activitySubject: 'all' })

    const { container } = render(<ActivityView />)

    await waitFor(() => expect(getAllActivity).toHaveBeenCalledWith(30))
    // Every panel's visually-hidden SR data table is also a <table> now —
    // scope to the sortable ALL-USERS table specifically (`.activity-table`).
    await waitFor(() => expect(container.querySelector('table.activity-table')).not.toBeNull())
    const table = container.querySelector('table.activity-table') as HTMLTableElement
    // Default sort: credits desc — Bea (9) before Ada (1).
    let rows = within(table).getAllByRole('row').slice(1) // drop header row
    expect(within(rows[0]).getByText('Bea')).toBeTruthy()
    expect(within(rows[1]).getByText('Ada')).toBeTruthy()

    // Header click flips the sort order. The button's accessible name now
    // carries a trailing sort-direction indicator (▲/▼), so match on the
    // label prefix rather than the exact translated string.
    fireEvent.click(within(table).getByRole('button', { name: new RegExp(`^${en.activityTableCredits}`) }))
    rows = within(table).getAllByRole('row').slice(1)
    expect(within(rows[0]).getByText('Ada')).toBeTruthy()
    expect(within(rows[1]).getByText('Bea')).toBeTruthy()

    fireEvent.click(within(rows[0]).getByText('Ada'))
    await waitFor(() => expect(getUserActivity).toHaveBeenCalledWith(1, 30))
    await screen.findByText('Ada')
    expect(container.querySelector('table.activity-table')).toBeNull()
    const back = screen.getByRole('button', { name: en.activityBack })

    fireEvent.click(back)
    await waitFor(() => expect(getAllActivity).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(container.querySelector('table.activity-table')).not.toBeNull())
  })
})

describe('ActivityView: error path', () => {
  it('renders the load-error message on a rejected fetch', async () => {
    vi.mocked(getOwnActivity).mockRejectedValue(new Error('network down'))

    render(<ActivityView />)

    await screen.findByText(en.activityLoadError)
  })
})

describe('ActivityView: pending path', () => {
  it('shows the loading message while the fetch is unresolved', async () => {
    let resolveFetch!: (value: ActivityResponse) => void
    vi.mocked(getOwnActivity).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )

    render(<ActivityView />)

    await screen.findByText(en.activityLoading)
    resolveFetch(selfFixture())
    await waitFor(() => expect(screen.queryByText(en.activityLoading)).toBeNull())
  })
})

describe('ActivityView: all-zero response', () => {
  it('still renders all three panel titles and three chart svgs — never a blank screen', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(zeroFixture())

    const { container } = render(<ActivityView />)

    await screen.findByText(en.activityRuns, { selector: '.activity-panel-label' })
    screen.getByText(en.activityTokens, { selector: '.activity-panel-label' })
    screen.getByText(en.activityCredits, { selector: '.activity-panel-label' })
    expect(container.querySelectorAll('svg.activity-chart').length).toBe(3)
  })
})

describe('ActivityView: session re-login refetch', () => {
  it('refetches when authGeneration bumps (silent same-user re-login mid-view)', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(selfFixture())

    render(<ActivityView />)
    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledTimes(1))

    // No real login() call here (that pulls in the whole session/document
    // hydration chain) — bumping the reactive counter directly is exactly
    // what login()'s own commit does on a silent same-user re-login (see
    // auth/session.ts), and the effect depending on it is what should react.
    useStore.getState().bumpAuthGeneration()

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledTimes(2))
  })
})

describe('ActivityView: sort-state accessibility', () => {
  it('exposes aria-sort on the active column and flips it on toggle', async () => {
    vi.mocked(getAllActivity).mockResolvedValue(allFixture())
    useStore.setState({ user: user({ is_admin: true }), activitySubject: 'all' })

    const { container } = render(<ActivityView />)
    await waitFor(() => expect(container.querySelector('table.activity-table')).not.toBeNull())
    const table = container.querySelector('table.activity-table') as HTMLTableElement

    // Default sort: credits, descending — pinned by the fixed-fixture test
    // above via row order; here the header itself must say so. Scoped to
    // the sortable table: the credits panel's SR data table also has a
    // "Credits" <th>, but it carries no aria-sort at all.
    const creditsHeader = within(table).getByRole('columnheader', {
      name: new RegExp(`^${en.activityTableCredits}`),
    })
    expect(creditsHeader.getAttribute('aria-sort')).toBe('descending')
    const runsHeader = within(table).getByRole('columnheader', {
      name: new RegExp(`^${en.activityTotalRuns}`),
    })
    expect(runsHeader.getAttribute('aria-sort')).toBe('none')

    fireEvent.click(within(creditsHeader).getByRole('button'))
    expect(creditsHeader.getAttribute('aria-sort')).toBe('ascending')
  })
})

describe('ActivityView: out-of-order fetch resolution', () => {
  it('keeps the newer response when an older in-flight request settles after it (latest-wins)', async () => {
    let resolveFirst!: (value: ActivityResponse) => void
    let resolveSecond!: (value: ActivityResponse) => void
    vi.mocked(getOwnActivity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        }),
    )

    render(<ActivityView />)
    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledTimes(1))

    vi.mocked(getOwnActivity).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: en.activityDays90 }))
    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledTimes(2))

    const newerLine = `42 ${en.activityTotalRuns} · 1 ${en.activityInput} / 1 ${en.activityOutput} · 1 ${en.activityTableCredits}`
    const staleLine = `999 ${en.activityTotalRuns} · 2 ${en.activityInput} / 2 ${en.activityOutput} · 2 ${en.activityTableCredits}`

    // The newer (second) request settles first...
    resolveSecond({ ...selfFixture(), totals: { runs: 42, input_tokens: 1, output_tokens: 1, credits: 1 } })
    await screen.findByText(newerLine)

    // ...then the older (first, now-superseded) request settles late. Without
    // the effect's cleanup flag, this would overwrite the newer numbers.
    resolveFirst({ ...selfFixture(), totals: { runs: 999, input_tokens: 2, output_tokens: 2, credits: 2 } })
    await new Promise((r) => setTimeout(r, 0))

    screen.getByText(newerLine)
    expect(screen.queryByText(staleLine)).toBeNull()
  })
})

describe('ActivityView: locale-aware date rendering', () => {
  it('renders chart x-axis dates in the active UI locale (de: dd.mm.yyyy)', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(selfFixture())
    useStore.setState({ uiLocale: 'de' })

    const { container } = render(<ActivityView />)

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(30))
    await screen.findByText(de.activityRuns, { selector: '.activity-panel-label' })
    // selfFixture's last day is 2026-07-26 — de formats it dd.mm.yyyy, not
    // the raw ISO string.
    const labels = Array.from(container.querySelectorAll('text.chart-xlabel')).map(
      (el) => el.textContent,
    )
    expect(labels).toContain('26.07.2026')
    expect(labels).not.toContain('2026-07-26')
  })
})

describe('ActivityView: chart legend and screen-reader data table', () => {
  it('renders one legend swatch+label per series for the runs panel', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(selfFixture())

    const { container } = render(<ActivityView />)

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(30))
    await screen.findByText(en.activityRuns, { selector: '.activity-panel-label' })

    const runsPanel = container.querySelectorAll('.activity-panel')[0]
    const items = runsPanel.querySelectorAll('.chart-legend-item')
    expect(items.length).toBe(4)
    const labels = Array.from(items).map((el) => el.textContent)
    expect(labels).toEqual([
      en.activityCheck,
      en.activitySuggestion,
      en.activityName,
      en.activityFailed,
    ])
    // Every entry carries a swatch element.
    expect(runsPanel.querySelectorAll('.chart-legend-swatch').length).toBe(4)
  })

  it('gives each panel a visually-hidden data table mirroring the chart props, with the fixture\'s first-day values', async () => {
    vi.mocked(getOwnActivity).mockResolvedValue(selfFixture())

    const { container } = render(<ActivityView />)

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(30))
    await screen.findByText(en.activityRuns, { selector: '.activity-panel-label' })

    const runsPanel = container.querySelectorAll('.activity-panel')[0]
    // .visually-hidden sits on the WRAPPER div, not the <table> itself:
    // CSS table layout treats width/height as minimums, so a table
    // carrying the class directly still lays out at full min-content size
    // (2026-08-22 scroll bug) — a div is what actually clips to 1x1.
    const wrapper = runsPanel.querySelector('div.visually-hidden')
    expect(wrapper).not.toBeNull()
    const table = wrapper?.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.classList.contains('visually-hidden')).toBe(false)
    expect(table?.querySelector('caption')?.textContent).toBe(en.activityRuns)

    const rows = table?.querySelectorAll('tr') ?? []
    // 3 fixture days + 1 header row.
    expect(rows.length).toBe(4)

    const headerCells = Array.from(rows[0].querySelectorAll('th')).map((el) => el.textContent)
    expect(headerCells).toEqual([
      en.windowName('day'),
      en.activityCheck,
      en.activitySuggestion,
      en.activityName,
      en.activityFailed,
    ])

    // First data row: 2026-07-24 — check=1, suggestion=0, name=0, failed=0.
    // The date cell is a row header (<th scope="row">), not a <td> — so AT
    // announces the day together with each value as it reads across the
    // row — hence `.children` (every direct cell, th or td) rather than a
    // tag-specific query.
    const firstDataRow = rows[1]
    expect(firstDataRow.querySelector('th')?.getAttribute('scope')).toBe('row')
    const firstDataCells = Array.from(firstDataRow.children).map((el) => el.textContent)
    expect(firstDataCells).toEqual([formatDay('2026-07-24', 'en'), '1', '0', '0', '0'])
  })
})

describe('ActivityView: scroll reset on subject navigation', () => {
  it('resets .activity-view scrollTop to 0 when drilling from the all-users table into a user', async () => {
    vi.mocked(getAllActivity).mockResolvedValue(allFixture())
    vi.mocked(getUserActivity).mockResolvedValue(userActivityFixture())
    useStore.setState({ user: user({ is_admin: true }), activitySubject: 'all' })

    const { container } = render(<ActivityView />)

    await waitFor(() => expect(getAllActivity).toHaveBeenCalledWith(30))
    await waitFor(() => expect(container.querySelector('table.activity-table')).not.toBeNull())
    const table = container.querySelector('table.activity-table') as HTMLTableElement
    const scrollEl = container.querySelector('.activity-view') as HTMLDivElement

    // Simulates the tall all-users table page having been scrolled down
    // before the drill-down click below — the bug this guards against.
    scrollEl.scrollTop = 500

    const rows = within(table).getAllByRole('row').slice(1)
    fireEvent.click(within(rows[0]).getByRole('button'))
    await waitFor(() => expect(getUserActivity).toHaveBeenCalled())

    expect(scrollEl.scrollTop).toBe(0)
  })
})
