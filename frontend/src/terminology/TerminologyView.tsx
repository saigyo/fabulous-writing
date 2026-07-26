import { useCallback, useEffect, useState } from 'react'
import {
  createDomain,
  createTerm,
  deleteDomain,
  deleteTerm,
  getDomains,
  getTerms,
  updateDomain,
  updateTerm,
} from '../api/client'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Domain, Language, Term } from '../types'
import {
  draftToTermPayload,
  filterTerms,
  sortTerms,
  termToDraft,
  toggleSort,
  type SortCriterion,
  type SortKey,
  type TermDraft,
} from './termTable'

export function TerminologyView() {
  const domains = useStore((s) => s.domains)
  const setDomains = useStore((s) => s.setDomains)
  const isAdmin = useStore((s) => s.user?.is_admin ?? false)
  const [activeDomainId, setActiveDomainId] = useState<number | null>(null)
  const [terms, setTerms] = useState<Term[]>([])
  const [newDomain, setNewDomain] = useState('')
  const m = useMessages()
  const { error, run } = useCrudError(m.changeFailed)

  const refreshDomains = useCallback(() => {
    const gen = sessionGeneration()
    return getDomains().then((domains) => {
      if (sessionGeneration() === gen) setDomains(domains)
    })
  }, [setDomains])

  useEffect(() => {
    void refreshDomains()
  }, [refreshDomains])

  useEffect(() => {
    if (activeDomainId === null && domains.length > 0) {
      setActiveDomainId(domains[0].id)
    }
  }, [domains, activeDomainId])

  useEffect(() => {
    if (activeDomainId !== null) {
      getTerms(activeDomainId).then(setTerms)
    } else {
      setTerms([])
    }
  }, [activeDomainId])

  async function addDomain() {
    if (!newDomain.trim()) return
    await run(async () => {
      const domain = await createDomain(newDomain.trim())
      setNewDomain('')
      await refreshDomains()
      setActiveDomainId(domain.id)
    })
  }

  async function removeDomain(id: number) {
    await run(async () => {
      await deleteDomain(id)
      if (activeDomainId === id) setActiveDomainId(null)
      await refreshDomains()
    })
  }

  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function startRename(domain: { id: number; name: string }) {
    setRenamingId(domain.id)
    setRenameValue(domain.name)
  }

  async function saveRename() {
    const name = renameValue.trim()
    if (renamingId === null || !name) return // empty: stay open until corrected or cancelled
    await run(async () => {
      await updateDomain(renamingId, name)
      setRenamingId(null)
      await refreshDomains()
    })
  }

  const activeDomain = domains.find((domain) => domain.id === activeDomainId) ?? null

  return (
    <div className="terminology">
      {error && <p className="crud-error">{error}</p>}
      <aside className="domain-list">
        <h2>{m.domains}</h2>
        {domains.map((domain) => {
          const editable = !domain.is_global || isAdmin
          return (
            <div
              key={domain.id}
              className={`domain-row${domain.id === activeDomainId ? ' selected' : ''}`}
              onClick={() => setActiveDomainId(domain.id)}
            >
              {domain.id === renamingId ? (
                <input
                  value={renameValue}
                  autoFocus
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveRename()
                    if (event.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={() => setRenamingId(null)}
                />
              ) : (
                <span onDoubleClick={() => editable && startRename(domain)}>{domain.name}</span>
              )}
              {domain.is_global && (
                <span className="global-badge" title={m.globalBadgeTitle}>
                  {m.globalBadge}
                </span>
              )}
              {editable && (
                <>
                  <button
                    className="icon-button"
                    title={m.renameDomainTitle}
                    onClick={(event) => {
                      event.stopPropagation()
                      startRename(domain)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-button"
                    title={m.deleteDomainTitle}
                    onClick={(event) => {
                      event.stopPropagation()
                      void removeDomain(domain.id)
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          )
        })}
        <div className="add-domain">
          <input
            value={newDomain}
            placeholder={m.newDomainPlaceholder}
            onChange={(event) => setNewDomain(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void addDomain()}
          />
          <button onClick={() => void addDomain()}>{m.add}</button>
        </div>
      </aside>
      {activeDomain !== null && (
        <TermTable
          domain={activeDomain}
          terms={terms}
          onChanged={() => getTerms(activeDomain.id).then(setTerms)}
          run={run}
          readOnly={activeDomain.is_global && !isAdmin}
        />
      )}
    </div>
  )
}

interface TermTableProps {
  domain: Domain
  terms: Term[]
  onChanged: () => void
  run: (action: () => Promise<void>) => Promise<void>
  readOnly: boolean
}

function TermTable({ domain, terms, onChanged, run, readOnly }: TermTableProps) {
  const domainId = domain.id
  const languages = useStore((s) => s.languages)
  const m = useMessages()
  const [addDraft, setAddDraft] = useState<TermDraft>({
    language: 'en',
    preferred: '',
    variants: '',
    definition: '',
    caseSensitive: false,
  })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<TermDraft | null>(null)
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([])
  const [languageFilter, setLanguageFilter] = useState<Language | null>(null)
  const [query, setQuery] = useState('')

  const visibleTerms = sortTerms(filterTerms(terms, languageFilter, query), sortCriteria)

  function onToggleSort(key: SortKey) {
    setSortCriteria((old) => toggleSort(old, key))
  }

  async function addTerm() {
    const payload = draftToTermPayload(addDraft)
    if (!payload) return
    await run(async () => {
      await createTerm(domainId, payload)
      setAddDraft((d) => ({ ...d, preferred: '', variants: '', definition: '' }))
      onChanged()
    })
  }

  function startEdit(term: Term) {
    setEditingId(term.id)
    setEditDraft(termToDraft(term))
  }

  function cancelEdit() {
    setEditingId(null)
    setEditDraft(null)
  }

  async function saveEdit() {
    if (editingId === null || editDraft === null) return
    const payload = draftToTermPayload(editDraft)
    if (!payload) return
    await run(async () => {
      await updateTerm(editingId, payload)
      cancelEdit()
      onChanged()
    })
  }

  return (
    <section className="term-table">
      <h2>{m.terms}</h2>
      <table>
        <thead>
          <tr className="term-controls-row">
            <td>
              <select
                className="term-language-filter"
                value={languageFilter ?? ''}
                title={m.languageFilterTitle}
                onChange={(event) =>
                  setLanguageFilter(
                    event.target.value === '' ? null : (event.target.value as Language),
                  )
                }
              >
                <option value="">{m.allLanguages}</option>
                {languages.map((info) => (
                  <option key={info.code} value={info.code}>
                    {info.name}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <input
                type="search"
                className="term-search"
                value={query}
                placeholder={m.searchTermsPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </td>
            <td colSpan={3}></td>
          </tr>
          <tr>
            <SortableHeader label={m.langHeader} sortKey="language" criteria={sortCriteria} onToggle={onToggleSort} />
            <SortableHeader label={m.preferredHeader} sortKey="preferred" criteria={sortCriteria} onToggle={onToggleSort} />
            <SortableHeader label={m.doNotUseHeader} sortKey="forbidden" criteria={sortCriteria} onToggle={onToggleSort} />
            <th>{m.definitionHeader}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleTerms.length === 0 && terms.length > 0 && (
            <tr className="no-terms-row">
              <td colSpan={5}>{m.noTermsMatch}</td>
            </tr>
          )}
          {visibleTerms.map((term) =>
            term.id === editingId && editDraft ? (
              <tr key={term.id} className="term-edit-row">
                <TermFieldCells
                  draft={editDraft}
                  onChange={setEditDraft}
                  onSubmit={() => void saveEdit()}
                  onCancel={cancelEdit}
                />
                <td>
                  <button
                    className="icon-button"
                    title={m.saveEditTitle}
                    onClick={() => void saveEdit()}
                  >
                    ✓
                  </button>
                  <button className="icon-button" title={m.cancelEditTitle} onClick={cancelEdit}>
                    ✕
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={term.id}>
                <td>{languageName(term.language, languages)}</td>
                <td className="term-preferred">{term.preferred}</td>
                <td>
                  {term.forbidden_variants.join(', ')}
                  {term.case_sensitive && (
                    <span className="case-badge" title={m.caseSensitiveTitle}>
                      Aa
                    </span>
                  )}
                </td>
                <td>{term.definition}</td>
                <td>
                  {!readOnly && (
                    <>
                      <button
                        className="icon-button"
                        title={m.editTermTitle}
                        onClick={() => startEdit(term)}
                      >
                        ✎
                      </button>
                      <button
                        className="icon-button"
                        title={m.deleteTermTitle}
                        onClick={() =>
                          void run(async () => {
                            await deleteTerm(term.id)
                            onChanged()
                          })
                        }
                      >
                        ✕
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ),
          )}
          {!readOnly && (
            <tr className="add-term">
              <TermFieldCells draft={addDraft} onChange={setAddDraft} onSubmit={() => void addTerm()} />
              <td>
                <button onClick={() => void addTerm()}>{m.add}</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  )
}

interface TermFieldCellsProps {
  draft: TermDraft
  onChange: (draft: TermDraft) => void
  onSubmit: () => void
  /** Absent on the add row: Escape only applies to row edit mode. */
  onCancel?: () => void
}

// The four input cells shared by the add-term row and a row in edit mode.
function TermFieldCells({ draft, onChange, onSubmit, onCancel }: TermFieldCellsProps) {
  const languages = useStore((s) => s.languages)
  const m = useMessages()

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter') onSubmit()
    if (event.key === 'Escape') onCancel?.()
  }

  return (
    <>
      <td>
        <select
          value={draft.language}
          onChange={(event) => onChange({ ...draft, language: event.target.value as Language })}
        >
          {languages.map((info) => (
            <option key={info.code} value={info.code}>
              {info.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          value={draft.preferred}
          placeholder={m.preferredPlaceholder}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange({ ...draft, preferred: event.target.value })}
        />
      </td>
      <td>
        <div className="input-with-toggle">
          <input
            value={draft.variants}
            placeholder={m.forbiddenPlaceholder}
            onKeyDown={onKeyDown}
            onChange={(event) => onChange({ ...draft, variants: event.target.value })}
          />
          <button
            type="button"
            className="match-case-toggle"
            aria-pressed={draft.caseSensitive}
            title={m.caseSensitiveTitle}
            onClick={() => onChange({ ...draft, caseSensitive: !draft.caseSensitive })}
          >
            Aa
          </button>
        </div>
      </td>
      <td>
        <input
          value={draft.definition}
          placeholder={m.definitionPlaceholder}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange({ ...draft, definition: event.target.value })}
        />
      </td>
    </>
  )
}

interface SortableHeaderProps {
  label: string
  sortKey: SortKey
  criteria: SortCriterion[]
  onToggle: (key: SortKey) => void
}

function SortableHeader({ label, sortKey, criteria, onToggle }: SortableHeaderProps) {
  const m = useMessages()
  const index = criteria.findIndex((c) => c.key === sortKey)
  const direction = index >= 0 ? criteria[index].direction : null
  return (
    <th
      className={`sortable${direction ? ' sorted' : ''}`}
      title={m.sortHeaderTitle}
      onClick={() => onToggle(sortKey)}
    >
      {label}
      {direction && (
        <span className="sort-indicator">
          {direction === 'asc' ? '▲' : '▼'}
          {criteria.length > 1 && <sup>{index + 1}</sup>}
        </span>
      )}
    </th>
  )
}
