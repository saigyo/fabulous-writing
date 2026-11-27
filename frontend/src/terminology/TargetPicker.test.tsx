// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type { Concept, ConceptTerm, Language } from '../types'
import { TargetPicker } from './TargetPicker'

function term(id: number, text: string, usage: ConceptTerm['usage_status'] = 'preferred'): ConceptTerm {
  return {
    id,
    uid: `t${id}`,
    text,
    usage_status: usage,
    process_status: 'active',
    status_reason: '',
    context: '',
    source: '',
    part_of_speech: null,
    case_sensitive: false,
    revision: 1,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
  }
}

function concept(id: number, sections: Partial<Record<Language, ConceptTerm[]>>): Concept {
  return {
    id,
    uid: `c${id}`,
    domain_ids: [2],
    is_global: false,
    revision: 1,
    created_at: null,
    created_by: null,
    modified_at: null,
    modified_by: null,
    sections: Object.entries(sections).map(([language, terms], i) => ({
      id: id * 10 + i,
      language: language as Language,
      definition: '',
      revision: 1,
      created_at: null,
      created_by: null,
      modified_at: null,
      modified_by: null,
      terms: terms as ConceptTerm[],
    })),
  }
}

const email = concept(1, { en: [term(1, 'email'), term(2, 'e-mail', 'admitted')], de: [term(3, 'E-Mail')] })
const workflow = concept(2, { en: [term(4, 'workflow'), term(5, 'work flow', 'admitted')] })
const framework = concept(3, { en: [term(6, 'framework')] })
const collaboration = concept(4, { en: [term(7, 'collaboration'), term(8, 'teamwork', 'admitted')] })
const onlyGerman = concept(5, { de: [term(9, 'Schraube')] })
const all = [email, workflow, framework, collaboration, onlyGerman]
const order: Language[] = FALLBACK_LANGUAGES.map((l) => l.code)

function Harness({
  onPick,
  start = null,
  candidates = all,
}: {
  onPick: (c: Concept | null) => void
  start?: Concept | null
  candidates?: Concept[]
}) {
  const [target, setTarget] = useState<Concept | null>(start)
  return (
    <TargetPicker
      candidates={candidates}
      language="en"
      order={order}
      target={target}
      disabled={false}
      onPick={(c) => {
        setTarget(c)
        onPick(c)
      }}
    />
  )
}

const optionLabels = () => screen.getAllByRole('option').map((o) => o.querySelector('.target-option-text')?.textContent)

beforeEach(() => {
  useStore.setState({ uiLocale: 'en', languages: FALLBACK_LANGUAGES })
})

afterEach(cleanup)

describe('TargetPicker', () => {
  it('lists all candidates when it opens, in label order', () => {
    render(<Harness onPick={vi.fn()} />)
    expect(optionLabels()).toEqual(['collaboration', 'email', 'framework', 'Schraube', 'workflow'])
    expect(screen.getByRole('combobox', { name: 'Into' })).toHaveProperty('placeholder', 'Search concepts…')
  })

  it('narrows and reorders while typing and highlights every match', async () => {
    const user = userEvent.setup()
    render(<Harness onPick={vi.fn()} />)
    await user.type(screen.getByRole('combobox', { name: 'Into' }), 'work')
    await waitFor(() => expect(optionLabels()).toEqual(['workflow', 'collaboration', 'framework']))
    const marks = (o: HTMLElement) => [...o.querySelectorAll('mark')].map((m) => m.textContent)
    const options = screen.getAllByRole('option')
    expect(marks(options[0])).toEqual(['work', 'work'])
    expect(marks(options[1])).toEqual(['work'])
    expect(marks(options[2])).toEqual(['work'])
  })

  it('shows the language markers and the fallback marker of the label', () => {
    render(<Harness onPick={vi.fn()} />)
    const mail = screen.getByRole('option', { name: /email/ })
    expect(within(mail).getByTitle('English')).toBeTruthy()
    expect(within(mail).getByTitle('Deutsch')).toBeTruthy()
    const german = screen.getByRole('option', { name: /Schraube/ })
    expect(within(german).getAllByText('DE')).toHaveLength(2)
    expect(within(mail).getAllByText('EN')).toHaveLength(1)
  })

  it('picks by click', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    await user.click(screen.getByRole('option', { name: /workflow/ }))
    expect(onPick).toHaveBeenCalledWith(workflow)
  })

  it('picks the active row with the arrow keys and Enter, and nothing else reacts to Enter', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Harness onPick={onPick} />
        <button type="submit">Go</button>
      </form>,
    )
    const field = screen.getByRole('combobox', { name: 'Into' })
    await user.click(field)
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(field.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[2].id)
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(email)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('scrolls the newly active row into view', async () => {
    const user = userEvent.setup()
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      render(<Harness onPick={vi.fn()} />)
      await user.click(screen.getByRole('combobox', { name: 'Into' }))
      await user.keyboard('{ArrowDown}')
      expect(scroll).toHaveBeenCalledTimes(1)
      expect(scroll.mock.contexts[0]).toBe(screen.getAllByRole('option')[1])
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      // @ts-expect-error happy-dom has no scrollIntoView
      delete Element.prototype.scrollIntoView
    }
  })

  it('starts on the first row and does not run past the ends', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    await user.click(screen.getByRole('combobox', { name: 'Into' }))
    await user.keyboard('{ArrowUp}{Enter}')
    expect(onPick).toHaveBeenCalledWith(collaboration)
  })

  it('shows one row when nothing matches, and Enter picks nothing', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Harness onPick={onPick} />
        <button type="submit">Go</button>
      </form>,
    )
    await user.type(screen.getByRole('combobox', { name: 'Into' }), 'zzz{Enter}')
    expect(await screen.findByText('No concept matches.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('keeps the no-match row out of the listbox and reports whether options are shown', async () => {
    const user = userEvent.setup()
    render(<Harness onPick={vi.fn()} />)
    const field = screen.getByRole('combobox', { name: 'Into' })
    expect(field.getAttribute('aria-expanded')).toBe('true')
    await user.type(field, 'zzz')
    const none = await screen.findByText('No concept matches.')
    expect(none.closest('[role="listbox"]')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field.getAttribute('aria-expanded')).toBe('false')
    await user.clear(field)
    expect(field.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(field.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('listbox')
  })

  it('moves the focus to "Change" after a pick by click and by Enter', async () => {
    const user = userEvent.setup()
    render(<Harness onPick={vi.fn()} />)
    await user.click(screen.getByRole('option', { name: /workflow/ }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change' })))

    await user.click(screen.getByRole('button', { name: 'Change' }))
    const field = await screen.findByRole('combobox', { name: 'Into' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change' })))
  })

  it('does not move the focus for a target it was given', () => {
    render(<Harness onPick={vi.fn()} start={workflow} />)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Change' }))
  })

  it('hides the caption visually but keeps it as the field\'s name', () => {
    render(
      <TargetPicker
        candidates={all}
        language="en"
        order={order}
        target={null}
        disabled={false}
        onPick={vi.fn()}
        hideCaption
      />,
    )
    const field = screen.getByRole('combobox', { name: 'Into' })
    expect(document.querySelector(`label[for="${field.id}"]`)!.classList.contains('visually-hidden')).toBe(true)
  })

  it('shows the caption by default', () => {
    render(<Harness onPick={vi.fn()} />)
    const field = screen.getByRole('combobox', { name: 'Into' })
    expect(document.querySelector(`label[for="${field.id}"]`)!.classList.contains('visually-hidden')).toBe(false)
  })

  it('marks the field to be focused when the dialog opens, if asked', () => {
    render(
      <TargetPicker
        candidates={all}
        language="en"
        order={order}
        target={null}
        disabled={false}
        onPick={vi.fn()}
        autoFocus
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Into' }).hasAttribute('data-autofocus')).toBe(true)
  })

  it('shows the picked concept with a Change button that clears it and focuses the field', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Harness onPick={onPick} start={workflow} />)
    expect(screen.getByText('workflow')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Change' }))
    expect(onPick).toHaveBeenCalledWith(null)
    const field = await screen.findByRole('combobox', { name: 'Into' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(screen.getAllByRole('option')).toHaveLength(5)
  })
})
