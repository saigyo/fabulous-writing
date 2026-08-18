// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeResponse } from '../api/client'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { Profile } from '../types'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  getRules: vi.fn().mockResolvedValue({ rules: [], errors: [], packs: ['techdocs'] }),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  resetProfile: vi.fn(),
}))

import { updateProfile } from '../api/client'
import { ProfilesView } from './ProfilesView'

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

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    language: 'en',
    name: 'Global Profile',
    is_standard: false,
    categories_off: [],
    rule_exceptions: [],
    packs_on: [],
    domain_ids: [],
    llm_provider: 'ollama',
    llm_model: null,
    llm_tier: null,
    llm_instructions: '',
    example_text: '',
    is_global: true,
    ...overrides,
  }
}

/** Every interactive element within a card ought to be exactly the set of
 * controls that can reach onSave once ✕/↺ are hidden by readOnly — so a
 * blanket sweep (rather than naming each control) can't miss one the way
 * M2's directory sweep did. */
function controlsOf(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll('input, select, button, textarea'))
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    uiLocale: 'en',
    language: 'en',
    domains: [],
    providers: [],
    routing: null,
    profileId: null,
  })
})

describe('ProfilesView ownership affordances (non-admin)', () => {
  beforeEach(() => {
    useStore.setState({ user: user({ is_admin: false }) })
  })

  it('renders the built-in badge and disables every onSave-reaching control on a global card; hides delete and reset', async () => {
    useStore.setState({ profiles: [profile()] })
    render(<ProfilesView />)

    const card = screen.getByDisplayValue('Global Profile').closest('.profile-card') as HTMLElement
    within(card).getByText(en.globalBadge)
    expect(within(card).queryByTitle(en.deleteProfileTitle)).toBeNull()
    expect(within(card).queryByTitle(en.resetStandardTitle)).toBeNull()

    await screen.findByText(en.packName('techdocs')) // packs effect has resolved
    const controls = controlsOf(card)
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(true)
    }
  })

  it('clicking a pack button and the clear-pin button on a global card results in no onSave call', async () => {
    useStore.setState({ profiles: [profile()] })
    render(<ProfilesView />)
    await screen.findByText(en.packName('techdocs'))

    fireEvent.click(screen.getByText(en.packName('techdocs')))
    fireEvent.click(screen.getByTitle(en.clearPin))

    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('guardedSave guard: a control that still reaches the handler does not call updateProfile on a global card', async () => {
    // Mirrors RulesView's saveRuleSelection guard test: the name input is
    // disabled in the DOM, so this forces it past `disabled` to prove
    // guardedSave's own readOnly early-return — not the browser's native
    // disabled-blocks-events behavior — is what stops the write.
    useStore.setState({ profiles: [profile()] })
    render(<ProfilesView />)

    const nameInput = screen.getByDisplayValue('Global Profile') as HTMLInputElement
    expect(nameInput.disabled).toBe(true) // sanity: normally blocked
    nameInput.disabled = false
    fireEvent.change(nameInput, { target: { value: 'Renamed' } })
    fireEvent.blur(nameInput)

    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('leaves a private card fully editable', async () => {
    useStore.setState({
      profiles: [profile({ id: 2, name: 'Private Profile', is_global: false })],
    })
    render(<ProfilesView />)

    const card = screen.getByDisplayValue('Private Profile').closest('.profile-card') as HTMLElement
    expect(within(card).queryByText(en.globalBadge)).toBeNull()
    within(card).getByTitle(en.deleteProfileTitle)

    await screen.findByText(en.packName('techdocs'))
    const controls = controlsOf(card)
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(false)
    }
  })
})

describe('ProfilesView ownership affordances (admin)', () => {
  beforeEach(() => {
    useStore.setState({ user: user({ is_admin: true }) })
  })

  it('Standard global card: name stays disabled, reset shown, everything else editable', async () => {
    useStore.setState({
      profiles: [profile({ id: 3, name: 'Standard', is_standard: true, llm_provider: null })],
    })
    render(<ProfilesView />)
    await screen.findByText(en.packName('techdocs'))

    const card = screen.getByDisplayValue('Standard').closest('.profile-card') as HTMLElement
    expect((screen.getByDisplayValue('Standard') as HTMLInputElement).disabled).toBe(true)
    within(card).getByTitle(en.resetStandardTitle)
    expect(within(card).queryByTitle(en.deleteProfileTitle)).toBeNull()
    // Every other control (not the name input) is enabled for an admin.
    const others = controlsOf(card).filter((el) => el !== screen.getByDisplayValue('Standard'))
    for (const control of others) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(false)
    }
  })

  it('example (non-standard) global card: fully editable, delete shown', async () => {
    useStore.setState({
      profiles: [profile({ id: 4, name: 'Example Global', is_standard: false })],
    })
    render(<ProfilesView />)
    await screen.findByText(en.packName('techdocs'))

    const card = screen.getByDisplayValue('Example Global').closest('.profile-card') as HTMLElement
    within(card).getByTitle(en.deleteProfileTitle)
    expect(within(card).queryByTitle(en.resetStandardTitle)).toBeNull()
    for (const control of controlsOf(card)) {
      expect((control as HTMLButtonElement | HTMLInputElement).disabled).toBe(false)
    }
  })
})

describe('ProfilesView profile-card domain select disambiguation', () => {
  it('appends the built-in marker to a global domain option but not to a private one of the same name', async () => {
    // Per-owner uniqueness allows a private domain to shadow a global name
    // (two "Product docs") — the option text is the only thing that
    // distinguishes them since a <select> can't render the styled badge.
    useStore.setState({
      user: user({ is_admin: true }),
      profiles: [profile({ id: 5, name: 'Editable', domain_ids: [] })],
      domains: [
        { id: 1, name: 'Product docs', description: '', is_global: true },
        { id: 2, name: 'Product docs', description: '', is_global: false },
      ],
    })
    render(<ProfilesView />)
    await screen.findByText(en.packName('techdocs'))

    const card = screen.getByDisplayValue('Editable').closest('.profile-card') as HTMLElement
    const globalOption = within(card).getByText(`Product docs — ${en.globalBadge}`, {
      selector: 'option',
    }) as HTMLOptionElement
    expect(globalOption.value).toBe('1')
    const privateOption = within(card).getByText('Product docs', {
      exact: true,
      selector: 'option',
    }) as HTMLOptionElement
    expect(privateOption.value).toBe('2')
  })
})
