// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { Profile } from '../types'
import { bumpGeneration, resetAutosaveForTests } from '../documents/autosave'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  updateProfile: vi.fn(),
}))

import { updateProfile } from '../api/client'
import { ProfileSelector } from './ProfileSelector'

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    language: 'en',
    name: 'Standard',
    is_standard: true,
    categories_off: [],
    rule_exceptions: [],
    packs_on: [],
    domain_ids: [7],
    llm_provider: null,
    llm_model: null,
    llm_tier: 'quality',
    llm_instructions: '',
    example_text: '',
    is_global: true,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  resetAutosaveForTests()
  useStore.setState({
    profiles: [profile()],
    profileId: 1,
    // Differs from the stored profile's domain_ids ([7]) so isProfileDirty()
    // shows the Save-to-profile button.
    domainIds: [8],
    tier: 'quality',
    provider: 'ollama',
    model: null,
    uiLocale: 'en',
  })
})

describe('ProfileSelector saveOverrides generation guard', () => {
  it('writes the saved profile into the store when no session change occurred', async () => {
    vi.mocked(updateProfile).mockResolvedValue(profile({ domain_ids: [8] }))
    const u = userEvent.setup()
    render(<ProfileSelector />)
    await u.click(screen.getByTitle(en.saveToProfile))

    await waitFor(() =>
      expect(useStore.getState().profiles[0].domain_ids).toEqual([8]),
    )
  })

  it('discards a saveOverrides response that resolves after the session ended (logout/expiry mid-flight)', async () => {
    // Pins the fix: without the generation guard, this write also uses a
    // pre-await captured `profiles` array, so a session turnover mid-request
    // would clobber whatever the incoming session has since done with
    // `profiles` with the outgoing session's stale array.
    let resolveUpdate!: (p: Profile) => void
    vi.mocked(updateProfile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve
        }),
    )
    const u = userEvent.setup()
    render(<ProfileSelector />)
    await u.click(screen.getByTitle(en.saveToProfile))
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1))

    // Simulate the session ending while the request is in flight, and the
    // incoming session adding a second profile to the store.
    bumpGeneration()
    const incoming = [profile(), profile({ id: 2, name: 'Incoming' })]
    useStore.setState({ profiles: incoming })

    resolveUpdate(profile({ domain_ids: [8] }))
    await new Promise((r) => setTimeout(r, 0))

    expect(useStore.getState().profiles).toEqual(incoming)
  })
})
