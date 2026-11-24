import { useEffect, useState } from 'react'
import {
  createConcept,
  deleteConcept,
  getConcept,
  HttpError,
  removeConceptFromDomain,
  saveConcept,
  saveConceptLanguage,
} from '../api/client'
import { useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Concept, Domain, Language } from '../types'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import {
  addLanguage,
  applySaved,
  createBody,
  discardAll,
  discardSection,
  entryFromConcept,
  hasUnsaved,
  linksUnsaved,
  newEntry,
  reloadPart,
  saveAllBody,
  sectionProblems,
  toSectionInput,
  unsavedLanguages,
  withComment,
  type EntryState,
  type SectionState,
} from './conceptDraft'
import { conceptLabel } from './labels'
import { LanguageSectionEditor } from './LanguageSectionEditor'

interface ConceptEntryProps {
  domain: Domain
  domains: Domain[]
  concept: Concept | null
  newLanguage: Language
  readOnly: boolean
  onBack: () => void
  onSaved: (concept: Concept) => void
  onGone: () => void
  onUnsavedChange: (unsaved: boolean) => void
}

type ErrorSlot = Language | 'all' | 'header'

interface EntryError {
  at: ErrorSlot
  message: string
  conflict: boolean
  part?: Language | 'links'
}

export function ConceptEntry({
  domain,
  domains,
  concept,
  newLanguage,
  readOnly,
  onBack,
  onSaved,
  onGone,
  onUnsavedChange,
}: ConceptEntryProps) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const [state, setState] = useState<EntryState>(() =>
    concept ? entryFromConcept(concept) : newEntry(domain.id, domain.is_global, newLanguage),
  )
  const [current, setCurrent] = useState<Concept | null>(concept)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<EntryError | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingReload, setConfirmingReload] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)

  const unsaved = hasUnsaved(state)
  useEffect(() => {
    onUnsavedChange(unsaved)
  }, [unsaved, onUnsavedChange])
  useEffect(() => () => onUnsavedChange(false), [onUnsavedChange])

  const nameOf = (code: string) => languageName(code, languages)
  const conceptId = state.conceptId
  const isNew = conceptId === null
  const unsavedParts = unsavedLanguages(state)
  const blocked = state.sections.some(
    (s) => unsavedParts.includes(s.language) && sectionProblems(s).length > 0,
  )
  const canSaveAll = !busy && unsaved && !blocked && (!isNew || unsavedParts.length > 0)
  const inOtherDomain = state.savedDomainIds.some((id) => id !== domain.id)
  const linked = state.domainIds
    .filter((id) => id !== domain.id)
    .map((id) => domains.find((d) => d.id === id))
    .filter((d): d is Domain => d !== undefined)
  const offered = domains.filter(
    (d) => d.is_global === state.isGlobal && !state.domainIds.includes(d.id),
  )
  const missingLanguages = languages.filter(
    (info) => !state.sections.some((s) => s.language === info.code),
  )
  const label = isNew
    ? m.newConceptTitle
    : current
      ? conceptLabel(current, newLanguage, languages.map((l) => l.code)).text
      : ''

  function describe(e: unknown): Omit<EntryError, 'at'> {
    if (!(e instanceof HttpError)) {
      return { message: m.changeFailed(e instanceof Error ? e.message : String(e)), conflict: false }
    }
    if (e.code === 'conflict') {
      const message = e.part === 'links' ? m.conceptConflictLinks : m.conceptConflict(nameOf(e.part ?? ''))
      return { message, conflict: true, part: e.part as Language | 'links' | undefined }
    }
    if (e.code === 'duplicate_text') return { message: m.problemDuplicateText, conflict: false }
    if (e.code === 'second_preferred') return { message: m.problemSecondPreferred, conflict: false }
    return { message: m.changeFailed(e.detailMessage ?? e.message), conflict: false }
  }

  async function attempt(at: ErrorSlot, action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError({ at, ...describe(e) })
    } finally {
      setBusy(false)
    }
  }

  function commit(saved: Concept, sent: { languages: Language[]; links: boolean }) {
    setState((s) => applySaved(s, saved, sent))
    setCurrent(saved)
    setComment('')
    onSaved(saved)
  }

  function create(at: ErrorSlot) {
    const sent = { languages: unsavedLanguages(state), links: false }
    const body = createBody(state, comment)
    return attempt(at, async () => commit(await createConcept(domain.id, body), sent))
  }

  function saveSection(section: SectionState) {
    if (conceptId === null) return create(section.language)
    const { id, revision, definition, terms } = toSectionInput(section)
    const body = { id, revision, definition, terms, ...withComment(comment) }
    const sent = { languages: [section.language], links: false }
    return attempt(section.language, async () =>
      commit(await saveConceptLanguage(conceptId, section.language, body), sent),
    )
  }

  function saveEverything() {
    if (conceptId === null) return create('all')
    const sent = { languages: unsavedLanguages(state), links: linksUnsaved(state) }
    const body = saveAllBody(state, comment)
    return attempt('all', async () => commit(await saveConcept(conceptId, body), sent))
  }

  function forgetErrorOf(language: Language) {
    setError((e) => (e?.at === language || e?.part === language ? null : e))
  }

  function discardOne(language: Language) {
    if (isNew && state.sections.length === 1) return onBack()
    setState((s) => discardSection(s, language))
    forgetErrorOf(language)
  }

  function discardEverything() {
    if (isNew) return onBack()
    setState(discardAll)
    setError((e) => (e?.at === 'header' ? e : null))
  }

  function update(section: SectionState) {
    setState((s) => ({
      ...s,
      sections: s.sections.map((x) => (x.language === section.language ? section : x)),
    }))
  }

  function remove(section: SectionState) {
    if (section.saved === null) return discardOne(section.language)
    update({ ...section, removed: true })
    forgetErrorOf(section.language)
  }

  function setLinks(domainIds: number[]) {
    setState((s) => ({ ...s, domainIds }))
  }

  async function loadCurrentVersion(refused: EntryError) {
    const { part } = refused
    if (conceptId === null || part === undefined) return
    setBusy(true)
    try {
      const concept = await getConcept(conceptId)
      setState((s) => reloadPart(s, concept, part))
      setCurrent(concept)
      setError(null)
      onSaved(concept)
    } catch (e) {
      setError({ ...refused, message: describe(e).message })
    } finally {
      setBusy(false)
    }
  }

  function back() {
    if (unsaved) setConfirmingLeave(true)
    else onBack()
  }

  function errorAt(slot: ErrorSlot) {
    if (error?.at !== slot) return null
    return (
      <p className="entry-error" role="alert">
        <span>{error.message}</span>
        {error.conflict && (
          <button type="button" className="plain-button" disabled={busy} onClick={() => setConfirmingReload(true)}>
            {m.loadCurrentVersion}
          </button>
        )}
      </p>
    )
  }

  return (
    <section className="concept-entry">
      <div className="entry-header">
        <h2>
          <button type="button" className="link-button" disabled={busy} onClick={back}>
            ← {domain.name}
          </button>{' '}
          / {label}
        </h2>
        {!readOnly && conceptId !== null && (
          <>
            <button
              type="button"
              className="plain-button"
              disabled={busy || unsaved || !inOtherDomain}
              onClick={() =>
                void attempt('header', async () => {
                  await removeConceptFromDomain(domain.id, conceptId)
                  onGone()
                })
              }
            >
              {m.removeFromDomain}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              {m.deleteConcept}
            </button>
          </>
        )}
      </div>
      {errorAt('header')}
      <div className="entry-links">
        <span>{m.alsoInDomains}:</span>
        {linked.map((d) => (
          <span key={d.id} className="entry-link">
            {d.name}
            {!readOnly && (
              <button
                type="button"
                className="icon-button"
                aria-label={m.removeDomainLink(d.name)}
                title={m.removeDomainLink(d.name)}
                disabled={busy}
                onClick={() => setLinks(state.domainIds.filter((id) => id !== d.id))}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {linked.length === 0 && readOnly && <span>—</span>}
        {!readOnly && offered.length > 0 && (
          <select
            aria-label={m.addConceptDomain}
            value=""
            disabled={busy}
            onChange={(event) => setLinks([...state.domainIds, Number(event.target.value)])}
          >
            <option value="">{m.addConceptDomain}</option>
            {offered.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {state.sections.map((section) => (
        <LanguageSectionEditor
          key={section.language}
          section={section}
          readOnly={readOnly}
          saving={busy}
          saveBlocked={isNew && blocked}
          error={error?.at === section.language ? error.message : null}
          conflict={error?.at === section.language && error.conflict}
          onChange={update}
          onSave={() => void saveSection(section)}
          onDiscard={() => discardOne(section.language)}
          onRemove={() => remove(section)}
          onReload={() => setConfirmingReload(true)}
        />
      ))}
      {!readOnly && missingLanguages.length > 0 && (
        <select
          className="entry-add-language"
          aria-label={m.addLanguage}
          value=""
          disabled={busy}
          onChange={(event) => setState((s) => addLanguage(s, event.target.value as Language))}
        >
          <option value="">{m.addLanguage}</option>
          {missingLanguages.map((info) => (
            <option key={info.code} value={info.code}>
              {info.name}
            </option>
          ))}
        </select>
      )}
      {!readOnly && (
        <div className="entry-footer">
          <input
            aria-label={m.changeReason}
            placeholder={m.changeReason}
            value={comment}
            disabled={busy}
            onChange={(event) => setComment(event.target.value)}
          />
          {unsaved && (
            <span className="unsaved-marker">
              {m.unsavedList(
                [...unsavedParts.map(nameOf), ...(linksUnsaved(state) ? [m.unsavedLinks] : [])].join(', '),
              )}
            </span>
          )}
          <button type="button" className="plain-button" disabled={busy || !unsaved} onClick={discardEverything}>
            {m.discardAll}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canSaveAll}
            onClick={() => void saveEverything()}
          >
            {m.saveAll}
          </button>
        </div>
      )}
      {errorAt('all')}
      {confirmingDelete && conceptId !== null && (
        <ConfirmDialog
          title={m.deleteConcept}
          message={m.deleteConceptConfirm}
          confirmLabel={m.deleteConcept}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false)
            void attempt('header', async () => {
              await deleteConcept(conceptId)
              onGone()
            })
          }}
        />
      )}
      {confirmingReload && error?.part !== undefined && (
        <ConfirmDialog
          title={m.loadCurrentVersion}
          message={error.part === 'links' ? m.reloadLinksConfirm : m.reloadLanguageConfirm(nameOf(error.part))}
          confirmLabel={m.loadCurrentVersion}
          onCancel={() => setConfirmingReload(false)}
          onConfirm={() => {
            setConfirmingReload(false)
            void loadCurrentVersion(error)
          }}
        />
      )}
      {confirmingLeave && (
        <ConfirmDialog
          title={m.leaveUnsavedTitle}
          message={m.leaveUnsavedConfirm}
          confirmLabel={m.leaveUnsaved}
          onCancel={() => setConfirmingLeave(false)}
          onConfirm={() => {
            setConfirmingLeave(false)
            onBack()
          }}
        />
      )}
    </section>
  )
}
