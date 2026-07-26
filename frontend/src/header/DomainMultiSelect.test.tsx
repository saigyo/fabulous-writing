// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { useStore } from '../state/store'
import type { Domain } from '../types'
import { DomainMultiSelect } from './DomainMultiSelect'

function domain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: 1,
    name: 'Product docs',
    description: '',
    is_global: false,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  useStore.setState({
    domains: [],
    domainIds: [],
    uiLocale: 'en',
  })
})

describe('DomainMultiSelect ownership disambiguation', () => {
  it('appends the built-in marker to a global domain but not to a private one of the same name', async () => {
    // Per-owner uniqueness allows a private domain to shadow a global name
    // (two "Product docs") — the marker is the only thing that tells them
    // apart in this plain-text checkbox list.
    useStore.setState({
      domains: [
        domain({ id: 1, name: 'Product docs', is_global: true }),
        domain({ id: 2, name: 'Product docs', is_global: false }),
      ],
    })
    render(<DomainMultiSelect />)
    await userEvent.setup().click(screen.getByRole('button'))

    screen.getByText(`Product docs — ${en.globalBadge}`)
    const privateLabel = screen.getByText('Product docs', { exact: true })
    expect(privateLabel.textContent).toBe('Product docs')
  })
})
