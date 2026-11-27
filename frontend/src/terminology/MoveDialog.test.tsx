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
import { MoveDialog } from './MoveDialog'

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

const WORK_SPACE = term(101, 'work space', 'preferred')
const ARBEITSRAUM = term(103, 'Arbeitsraum', 'preferred')
const SOURCE = concept(10, { en: [WORK_SPACE, term(102, 'team space')], de: [ARBEITSRAUM] })
const WORKSPACE = concept(20, { en: [term(201, 'workspace', 'preferred')] })
const WORKFLOW = concept(21, { en: [term(211, 'workflow', 'preferred')] })
const CANDIDATES = [WORKSPACE, WORKFLOW]
const order: Language[] = FALLBACK_LANGUAGES.map((l) => l.code)

function basis(revision: number, target: number | null = 20): TransferOutcome['basis'] {
  const side = (id: number): ConceptBasis => ({
    concept_id: id,
    revision,
    sections: [{ id: id * 10, revision }],
  })
  return { source: side(10), target: target === null ? null : side(target) }
}

function outcome(over: Partial<TransferOutcome> = {}): TransferOutcome {
  return {
    target: concept(20, { en: [term(201, 'workspace', 'preferred'), term(102, 'team space')] }),
    source: concept(10, { en: [WORK_SPACE], de: [ARBEITSRAUM] }),
    moved: [{ id: 102, text: 'team space', language: 'en', usage_before: 'admitted', usage_after: 'admitted' }],
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

function renderDialog(props: Partial<Parameters<typeof MoveDialog>[0]> = {}) {
  const handlers = { onDone: vi.fn(), onClose: vi.fn() }
  render(
    <MoveDialog
      source={SOURCE}
      term={WORK_SPACE}
      candidates={CANDIDATES}
      language="en"
      order={order}
      comment=""
      canCreate
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

const moveButton = () => screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement
const deleteButton = () =>
  screen.getByRole('button', { name: 'Move and delete “work space”' }) as HTMLButtonElement
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
const toConcept = () => screen.getByRole('radio', { name: 'To the concept' }) as HTMLInputElement
const toNew = () => screen.getByRole('radio', { name: 'To a new concept' }) as HTMLInputElement

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

describe('MoveDialog', () => {
  it('selects "To the concept" on opening and keeps Move unavailable until a target is picked', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())])
    renderDialog()
    expect(screen.getByRole('heading', { name: 'Move “work space”' })).toBeTruthy()
    expect(screen.getByRole('radiogroup')).toBeTruthy()
    expect(toConcept().checked).toBe(true)
    expect(toNew().checked).toBe(false)
    expect(moveButton().disabled).toBe(true)
    expect(previews()).toHaveLength(0)

    await pick(user, 'workspace')
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    expect(previews()).toHaveLength(1)
    expect(previews()[0]).toMatchObject({ method: 'POST', path: '/api/terms/101/move' })
    expect(previews()[0].body).toMatchObject({ target_id: 20, preview: true })
  })

  it('shows no box for a move without side effects', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())])
    renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    expect(screen.queryByText('This also happens')).toBeNull()
  })

  it('shows the sentence of each kind of notice, in order', async () => {
    const user = userEvent.setup()
    serve([
      json(
        200,
        outcome({
          moved: [
            { id: 103, text: 'Arbeitsraum', language: 'de', usage_before: 'preferred', usage_after: 'admitted' },
          ],
          removed_languages: ['de', 'fr'],
          dropped_definitions: [{ language: 'de', definition: DEFINITION }],
          dropped_domains: [{ id: 3, name: 'Support' }],
          added_domains: [{ id: 5, name: 'Marketing' }],
        }),
      ),
    ])
    renderDialog({ term: ARBEITSRAUM })
    await pick(user, 'workspace')

    const dialog = screen.getByRole('dialog')
    const box = (await within(dialog).findByText('This also happens')).closest('.transfer-box') as HTMLElement
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '“Arbeitsraum” was preferred and becomes admitted.',
      `“work space” loses its section for Deutsch. Its definition is not taken over: “${DEFINITION}”`,
      '“work space” loses its section for Français.',
      'The term no longer applies in the domain “Support”.',
      'The term now also applies in the domain “Marketing”.',
    ])
  })

  it('shows the dropped definition and the deletion when the source concept goes', async () => {
    const user = userEvent.setup()
    serve([
      json(
        200,
        outcome({
          source: null,
          dropped_definitions: [{ language: 'de', definition: DEFINITION }],
        }),
      ),
    ])
    renderDialog()
    await pick(user, 'workspace')
    const box = (await screen.findByText('This also happens')).closest('.transfer-box') as HTMLElement
    expect(within(box).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `The definition for Deutsch is not taken over: “${DEFINITION}”`,
      'The concept “work space” has no term left and is deleted.',
    ])
  })

  it('quotes a definition the way the interface language does', async () => {
    const user = userEvent.setup()
    useStore.setState({ uiLocale: 'de' })
    serve([json(200, outcome({ source: null, dropped_definitions: [{ language: 'de', definition: DEFINITION }] }))])
    renderDialog()
    await pick(user, 'workspace')
    const quote = await screen.findByText(`„${DEFINITION}“`)
    expect(quote.className).toBe('transfer-quote')
    expect(quote.closest('li')!.textContent).toBe(`Die Definition für Deutsch wird nicht übernommen: „${DEFINITION}“`)
  })

  it('quotes the definition of a lost language the way the interface language does', async () => {
    const user = userEvent.setup()
    useStore.setState({ uiLocale: 'fr' })
    serve([json(200, outcome({ removed_languages: ['de'], dropped_definitions: [{ language: 'de', definition: DEFINITION }] }))])
    renderDialog({ term: ARBEITSRAUM })
    await pick(user, 'workspace')
    const quote = await screen.findByText(`« ${DEFINITION} »`)
    expect(quote.className).toBe('transfer-quote')
  })

  it('names the concept on a red button when the source is deleted, and says plain Move otherwise', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome({ source: null })), json(200, outcome())])
    renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(deleteButton().disabled).toBe(false))
    expect(deleteButton().className).toContain('confirm-dialog-danger')
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Change' }))
    await pick(user, 'workflow')
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    expect(moveButton().className).toContain('primary-button')
    expect(moveButton().className).not.toContain('confirm-dialog-danger')
  })

  it('previews a move to a new concept with target_id null and says where it lives', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome({ basis: basis(1, null) }))])
    renderDialog()
    await user.click(toNew())
    expect(toNew().checked).toBe(true)
    expect(await screen.findByText('The new concept is in the same domains as “work space”.')).toBeTruthy()
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    expect(previews()).toHaveLength(1)
    expect(previews()[0].body).toMatchObject({ target_id: null, preview: true })
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('offers no new concept without canCreate', () => {
    renderDialog({ canCreate: false })
    expect(screen.queryByRole('radio', { name: 'To a new concept' })).toBeNull()
    expect(toConcept()).toBeTruthy()
  })

  it('explains a refusal for the same wording and keeps Move unavailable', async () => {
    const user = userEvent.setup()
    serve([json(409, { detail: { code: 'duplicate_text', message: 'Duplicate.' } })])
    renderDialog({ term: term(102, 'work area') })
    await pick(user, 'workspace')
    expect(await screen.findByText('“workspace” already has the term “work area” in English.')).toBeTruthy()
    expect(screen.queryByText('Duplicate.')).toBeNull()
    expect(moveButton().disabled).toBe(true)
  })

  it('shows the message of another failed preview', async () => {
    const user = userEvent.setup()
    serve([json(409, { detail: { code: 'owner_mismatch', message: 'Different owners.' } })])
    renderDialog()
    await pick(user, 'workspace')
    expect(await screen.findByText('Change failed: Different owners.')).toBeTruthy()
    expect(moveButton().disabled).toBe(true)
  })

  it('keeps the picked target when switching and requests the matching preview', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome()), json(200, outcome({ basis: basis(1, null) })), json(200, outcome())])
    renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(moveButton().disabled).toBe(false))

    await user.click(toNew())
    await waitFor(() => expect(previews()).toHaveLength(2))
    expect(previews()[1].body.target_id).toBeNull()

    await user.click(toConcept())
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy()
    await waitFor(() => expect(previews()).toHaveLength(3))
    expect(previews()[2].body.target_id).toBe(20)
    await waitFor(() => expect(moveButton().disabled).toBe(false))
  })

  it('sends the basis and the comment, then reports the answer; nothing closes it meanwhile', async () => {
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
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    await user.click(moveButton())

    await waitFor(() => expect(runs()).toHaveLength(1))
    expect(runs()[0]).toMatchObject({ method: 'POST', path: '/api/terms/101/move' })
    expect(runs()[0].body).toEqual({ target_id: 20, basis: basis(1), comment: 'tidy up' })
    expect(moveButton().disabled).toBe(true)
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

  it('leaves out a reason of only spaces', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome())], async () => json(200, outcome()))
    const { onDone } = renderDialog({ comment: '   ' })
    await pick(user, 'workspace')
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    await user.click(moveButton())
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(runs()[0].body).toEqual({ target_id: 20, basis: basis(1) })
  })

  it('opens with the focus in the search field and shows no visible caption', () => {
    serve([json(200, outcome())])
    renderDialog()
    const field = screen.getByRole('combobox', { name: 'Into' })
    expect(document.activeElement).toBe(field)
    expect(document.querySelector(`label[for="${field.id}"]`)!.classList.contains('visually-hidden')).toBe(true)
  })

  it('sends a null target for a new concept', async () => {
    const user = userEvent.setup()
    serve([json(200, outcome({ basis: basis(1, null) }))], async () => json(200, outcome()))
    const { onDone } = renderDialog()
    await user.click(toNew())
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    await user.click(moveButton())
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(runs()[0].body).toEqual({ target_id: null, basis: basis(1, null) })
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
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    await user.click(moveButton())

    expect(
      await screen.findByText('“workspace” was changed in the meantime. This is the result as it would be now.'),
    ).toBeTruthy()
    await waitFor(() => expect(previews()).toHaveLength(2))
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    expect(onDone).not.toHaveBeenCalled()

    fetchMock.mockImplementation(async () => json(200, fresh))
    await user.click(moveButton())
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
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    await user.click(moveButton())
    expect(
      await screen.findByText('“work space” was changed in the meantime. This is the result as it would be now.'),
    ).toBeTruthy()
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
    expect(moveButton().disabled).toBe(true)
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
    expect(moveButton().disabled).toBe(true)
  })

  it('shows another failure of the run and keeps the dialog open and usable', async () => {
    const user = userEvent.setup()
    serve(
      [json(200, outcome())],
      async () => json(409, { detail: { code: 'same_concept', message: 'Cannot move into itself.' } }),
    )
    const { onDone, onClose } = renderDialog()
    await pick(user, 'workspace')
    await waitFor(() => expect(moveButton().disabled).toBe(false))
    await user.click(moveButton())

    expect(await screen.findByText('Change failed: Cannot move into itself.')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(moveButton().disabled).toBe(false)
    expect(cancelButton().disabled).toBe(false)
  })
})
