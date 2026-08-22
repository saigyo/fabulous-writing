// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityResponse, MeResponse, PerUserActivity } from '../api/client'
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
    await screen.findByText(en.activityRuns)
    screen.getByText(en.activityTokens)
    screen.getByText(en.activityCredits)
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

    render(<ActivityView />)

    await waitFor(() => expect(getOwnActivity).toHaveBeenCalledWith(30))
    expect(getAllActivity).not.toHaveBeenCalled()
    await screen.findByText(en.activityRuns)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText(en.activityBack)).toBeNull()
  })
})

describe('ActivityView: admin, all-users subject', () => {
  it('fetches all-users activity, renders sortable table rows, drills into a user, and returns via back', async () => {
    vi.mocked(getAllActivity).mockResolvedValue(allFixture())
    vi.mocked(getUserActivity).mockResolvedValue(userActivityFixture())
    useStore.setState({ user: user({ is_admin: true }), activitySubject: 'all' })

    render(<ActivityView />)

    await waitFor(() => expect(getAllActivity).toHaveBeenCalledWith(30))
    const table = await screen.findByRole('table')
    // Default sort: credits desc — Bea (9) before Ada (1).
    let rows = within(table).getAllByRole('row').slice(1) // drop header row
    expect(within(rows[0]).getByText('Bea')).toBeTruthy()
    expect(within(rows[1]).getByText('Ada')).toBeTruthy()

    // Header click flips the sort order. The button's accessible name now
    // carries a trailing sort-direction indicator (▲/▼), so match on the
    // label prefix rather than the exact translated string.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.activityTableCredits}`) }))
    rows = within(table).getAllByRole('row').slice(1)
    expect(within(rows[0]).getByText('Ada')).toBeTruthy()
    expect(within(rows[1]).getByText('Bea')).toBeTruthy()

    fireEvent.click(within(rows[0]).getByText('Ada'))
    await waitFor(() => expect(getUserActivity).toHaveBeenCalledWith(1, 30))
    await screen.findByText('Ada')
    expect(screen.queryByRole('table')).toBeNull()
    const back = screen.getByRole('button', { name: en.activityBack })

    fireEvent.click(back)
    await waitFor(() => expect(getAllActivity).toHaveBeenCalledTimes(2))
    await screen.findByRole('table')
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

    await screen.findByText(en.activityRuns)
    screen.getByText(en.activityTokens)
    screen.getByText(en.activityCredits)
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

    render(<ActivityView />)
    await screen.findByRole('table')

    // Default sort: credits, descending — pinned by the fixed-fixture test
    // above via row order; here the header itself must say so.
    const creditsHeader = screen.getByRole('columnheader', {
      name: new RegExp(`^${en.activityTableCredits}`),
    })
    expect(creditsHeader.getAttribute('aria-sort')).toBe('descending')
    const runsHeader = screen.getByRole('columnheader', {
      name: new RegExp(`^${en.activityTotalRuns}`),
    })
    expect(runsHeader.getAttribute('aria-sort')).toBe('none')

    fireEvent.click(within(creditsHeader).getByRole('button'))
    expect(creditsHeader.getAttribute('aria-sort')).toBe('ascending')
  })
})
