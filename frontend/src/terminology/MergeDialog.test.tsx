// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { FALLBACK_LANGUAGES } from '../languages'
import { useStore } from '../state/store'
import type {
  Concept,
  ConceptBasis,
  ConceptTerm,
  Language,
  TransferOutcome,
  UsageStatus,
} from '../types'
import { MergeDialog } from './MergeDialog'

function term(
  id: number,
  text: string,
  usage: UsageStatus = 'admitted',
  over: Partial<ConceptTerm> = {},
): ConceptTerm {
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
    ...over,
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

const SOURCE = concept(10, { en: [term(101, 'work space', 'preferred')] })
const WORKSPACE = concept(20, { en: [term(201, 'workspace', 'preferred')] })
const WORKFLOW = concept(21, { en: [term(211, 'workflow', 'preferred')] })
const CANDIDATES = [WORKSPACE, WORKFLOW]
const order: Language[] = FALLBACK_LANGUAGES.map((l) => l.code)

/** `revision` is the target's; the source is as the entry holds it (revision 1) unless `sourceRevision` says otherwise. */
function basis(revision: number, sourceRevision = 1): TransferOutcome['basis'] {
  const side = (id: number, rev: number): ConceptBasis => ({
    concept_id: id,
    revision: rev,
    sections: [{ id: id * 10, revision: rev }],
  })
  return { source: side(10, sourceRevision), target: side(20, revision) }
}

function outcome(over: Partial<TransferOutcome> = {}): TransferOutcome {
  return {
    target: concept(20, {
      en: [term(201, 'workspace', 'preferred'), term(101, 'work space', 'admitted')],
    }),
    source: null,
    moved: [{ id: 101, text: 'work space', language: 'en', usage_before: 'preferred', usage_after: 'admitted' }],
    dropped_terms: [],
    dropped_definitions: [],
    removed_languages: [],
    dropped_domains: [],
    added_domains: [],
    basis: basis(1),
    ...over,
  }
}

const DEFINITION = 'Bereich, in dem ein Team arbeitet.'

function everything(): TransferOutcome {
  return outcome({
    target: concept(20, {
      en: [
        term(201, 'workspace', 'preferred'),
        term(202, 'work area'),
        term(301, 'work space'),
        term(302, 'team space', 'admitted', { process_status: 'candidate' }),
        term(203, 'team room', 'forbidden'),
      ],
      de: [term(204, 'Arbeitsbereich', 'preferred'), term(303, 'Arbeitsraum')],
      fr: [term(304, 'espace de travail', 'preferred')],
    }),
    moved: [
      { id: 301, text: 'work space', language: 'en', usage_before: 'preferred', usage_after: 'admitted' },
      { id: 302, text: 'team space', language: 'en', usage_before: 'admitted', usage_after: 'admitted' },
      { id: 303, text: 'Arbeitsraum', language: 'de', usage_before: 'preferred', usage_after: 'admitted' },
      { id: 304, text: 'espace de travail', language: 'fr', usage_before: 'preferred', usage_after: 'preferred' },
    ],
    dropped_terms: [{ text: 'work area', language: 'en', usage_status: 'admitted' }],
    dropped_definitions: [{ language: 'de', definition: DEFINITION }],
    dropped_domains: [{ id: 3, name: 'Support' }],
    added_domains: [{ id: 5, name: 'Marketing' }],
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let fetchMock: MockInstance<typeof fetch>

interface Sent {
  method: string
  path: string
  body: Record<string, unknown>
}

function requests(): Sent[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: init?.method ?? 'GET',
    path: new URL(String(url)).pathname,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
  }))
}
const previews = () => requests().filter((r) => r.body.preview === true)
const runs = () => requests().filter((r) => r.body.preview !== true)

/** Answers the previews in order, then repeats the last; real runs go to `real`. */
function serve(previewAnswers: Response[], real: (() => Promise<Response>) | null = null) {
  let n = 0
  fetchMock.mockImplementation(async (_url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (body.preview === true) {
      const answer = previewAnswers[Math.min(n, previewAnswers.length - 1)]
      n += 1
      return answer.clone()
    }
    if (real === null) throw new Error('unexpected real run')
    return real()
  })
}

function renderDialog(props: Partial<Parameters<typeof MergeDialog>[0]> = {}) {
  const handlers = { onDone: vi.fn(), onClose: vi.fn() }
  render(
    <MergeDialog
      source={SOURCE}
      candidates={CANDIDATES}
      language="en"
      order={order}
      comment=""
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

const confirmButton = () =>
  screen.getByRole('button', { name: 'Merge and delete “work space”' }) as HTMLButtonElement
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement

async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${label}`) }))
}

function fireCancel() {
  const dialog = document.querySelector('dialog')!
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
}

function closeNatively() {
  const dialog = document.querySelector('dialog')!
  dialog.close()
  fireEvent(dialog, new Event('close'))
}

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch')
  useStore.setState({ uiLocale: 'en', languages: FALLBACK_LANGUAGES, token: 'token' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MergeDialog', () => {
  it('keeps confirm unavailable before a target is picked and while the preview loads', async () => {
    const user = userEvent.setup()
    fetchMock.mockReturnValue(new Promise<Response>(() => {}))
    renderDialog()
    expect(screen.getByRole('heading', { name: 'Merge “work space” into another concept' })).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
    await pick(user, 'workspace')
    expect(await screen.findByText('Working out the result…')).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
  })

  it('requests a preview for the picked target', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())])
    renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(previews()).toHaveLength(1)
    expect(previews()[0]).toMatchObject({ method: 'POST', path: '/api/concepts/10/merge' })
    expect(previews()[0].body).toMatchObject({ target_id: 20, preview: true })
  })

  it('shows everything the result can contain', async () => {
    const user = userEvent.setup()
    serve([json(200, everything())])
    renderDialog()
    await pick(user, 'workspace')

    const dialog = screen.getByRole('dialog')
    await within(dialog).findByText('Not taken over')
    const chips = within(dialog).getAllByRole('img')
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual([
      'workspace, preferred',
      'work area, admitted',
      'work space, admitted, new',
      'team space, admitted, candidate, new',
      'team room, forbidden',
      'Arbeitsbereich, preferred',
      'Arbeitsraum, admitted, new',
      'espace de travail, preferred, new',
    ])
    expect(chips[2].textContent).toContain('+')
    expect(chips[0].textContent).not.toContain('+')

    expect(within(dialog).getByText('“work space” was preferred and becomes admitted.')).toBeTruthy()
    expect(within(dialog).getByText('“Arbeitsraum” was preferred and becomes admitted.')).toBeTruthy()

    const box = within(dialog).getByText('Not taken over').closest('.transfer-box') as HTMLElement
    const items = within(box).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual([
      'The term “work area” (EN, admitted): “workspace” already has this wording.',
      `The definition for Deutsch: “${DEFINITION}” “workspace” keeps its own.`,
      'The domain “Support”: the moved terms no longer apply there.',
    ])
    expect(within(dialog).getByText('The moved terms now also apply in the domain “Marketing”.')).toBeTruthy()
  })

  it('shows neither the box nor the added-domain line for the simple outcome', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())])
    renderDialog()
    await pick(user, 'workspace')
    await screen.findByText('“work space” was preferred and becomes admitted.')
    expect(screen.queryByText('Not taken over')).toBeNull()
    expect(screen.queryByText(/now also apply/)).toBeNull()
  })

  it('clears the result and returns to the field on Change', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())])
    renderDialog()
    await pick(user, 'workspace')
    await screen.findByText('“work space” was preferred and becomes admitted.')
    await user.click(screen.getByRole('button', { name: 'Change' }))
    expect(screen.queryByText('“work space” was preferred and becomes admitted.')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Into' })).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
  })

  it('sends the basis on display and the comment, then reports the answer; nothing closes it meanwhile', async () => {
    const user = userEvent.setup()
    const answer = outcome({ basis: basis(2) })
    let finish!: (response: Response) => void
    serve(
      [json(200, outcome())],
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    const { onDone, onClose } = renderDialog({ comment: 'tidy up' })
    await pick(user, 'workspace')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await user.click(confirmButton())

    await waitFor(() => expect(runs()).toHaveLength(1))
    expect(runs()[0].body).toEqual({ target_id: 20, basis: basis(1), comment: 'tidy up' })
    expect(confirmButton().disabled).toBe(true)
    expect(cancelButton().disabled).toBe(true)
    fireCancel()
    expect(onClose).not.toHaveBeenCalled()
    closeNatively()
    expect(document.querySelector('dialog')!.open).toBe(true)
    expect(onDone).not.toHaveBeenCalled()

    finish(json(200, answer))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(answer))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('quotes a definition the way the interface language does', async () => {
    const user = userEvent.setup()
    useStore.setState({ uiLocale: 'de' })
    serve([json(200, everything())])
    renderDialog()
    await pick(user, 'workspace')
    const quote = await screen.findByText(`„${DEFINITION}“`)
    expect(quote.className).toBe('transfer-quote')
    expect(quote.closest('li')!.textContent).toBe(`Die Definition für Deutsch: „${DEFINITION}“ „workspace“ behält ihre eigene.`)
  })

  it('leaves out a reason of only spaces', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())], async () => json(200, outcome()))
    const { onDone } = renderDialog({ comment: '   ' })
    await pick(user, 'workspace')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await user.click(confirmButton())
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(runs()[0].body).toEqual({ target_id: 20, basis: basis(1) })
  })

  it('opens with the focus in the search field and a visible caption', () => {
    renderDialog()
    const field = screen.getByRole('combobox', { name: 'Into' })
    expect(document.activeElement).toBe(field)
    expect(document.querySelector(`label[for="${field.id}"]`)!.classList.contains('visually-hidden')).toBe(false)
  })

  it('closes on Cancel and Escape when nothing runs', async () => {
    const user = userEvent.setup()
    const { onClose } = renderDialog()
    fireCancel()
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(cancelButton())
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('names the changed concept after an out-of-date refusal and confirms against a fresh preview', async () => {
    const user = userEvent.setup()
    const fresh = outcome({ basis: basis(2) })
    serve(
      [json(200, outcome()), json(200, fresh)],
      async () => json(409, { detail: { code: 'outdated', message: 'changed', concept_id: 20 } }),
    )
    const { onDone } = renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await user.click(confirmButton())

    expect(
      await screen.findByText('“workspace” was changed in the meantime. This is the result as it would be now.'),
    ).toBeTruthy()
    await waitFor(() => expect(previews()).toHaveLength(2))
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(onDone).not.toHaveBeenCalled()

    fetchMock.mockImplementation(async () => json(200, fresh))
    await user.click(confirmButton())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(fresh))
    expect(runs().at(-1)!.body.basis).toEqual(basis(2))
  })

  it('names the source when the source is the changed concept', async () => {
    const user = userEvent.setup()
    serve(
      [json(200, outcome()), json(200, outcome())],
      async () => json(409, { detail: { code: 'outdated', message: 'changed', concept_id: 10 } }),
    )
    renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await user.click(confirmButton())
    expect(
      await screen.findByText('“work space” was changed in the meantime. This is the result as it would be now.'),
    ).toBeTruthy()
  })

  it.each([
    ['names another source concept', () => outcome({ basis: { ...basis(1), source: { concept_id: 30, revision: 1, sections: [{ id: 100, revision: 1 }] } } })],
    ['has a newer source revision', () => outcome({ basis: basis(1, 2) })],
  ])('shows the stale-source sentence and no result when the preview %s', async (_name, make) => {
    const user = userEvent.setup()
    serve([json(200, make())])
    renderDialog()
    await pick(user, 'workspace')
    expect(
      await screen.findByText(
        '“work space” was changed in the meantime. Close this dialog and open the concept again.',
      ),
    ).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
    expect(document.querySelector('.transfer-result')).toBeNull()
  })

  it('shows the message of a failed preview and keeps confirm unavailable', async () => {
    const user = userEvent.setup()
    serve([json(409, { detail: { code: 'owner_mismatch', message: 'Different owners.' } })])
    renderDialog()
    await pick(user, 'workspace')
    expect(await screen.findByText('Change failed: Different owners.')).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
  })

  it('shows a failed preview whose concept is outdated as a sentence naming it and keeps confirm unavailable', async () => {
    const user = userEvent.setup()
    serve([json(409, { detail: { code: 'outdated', message: 'changed', concept_id: 20 } })])
    renderDialog()
    await pick(user, 'workspace')
    expect(
      await screen.findByText(
        '“workspace” was changed in the meantime. Close this dialog and open the concept again.',
      ),
    ).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
  })

  it('names the source when the source is the concept an outdated preview names', async () => {
    const user = userEvent.setup()
    serve([json(409, { detail: { code: 'outdated', message: 'changed', concept_id: 10 } })])
    renderDialog()
    await pick(user, 'workspace')
    expect(
      await screen.findByText(
        '“work space” was changed in the meantime. Close this dialog and open the concept again.',
      ),
    ).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)
  })

  it('shows another failure of the run and keeps the dialog open and usable', async () => {
    const user = userEvent.setup()
    serve(
      [json(200, outcome())],
      async () => json(409, { detail: { code: 'same_concept', message: 'Cannot merge into itself.' } }),
    )
    const { onDone, onClose } = renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    await user.click(confirmButton())

    expect(await screen.findByText('Change failed: Cannot merge into itself.')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(confirmButton().disabled).toBe(false)
    expect(cancelButton().disabled).toBe(false)
  })
})
