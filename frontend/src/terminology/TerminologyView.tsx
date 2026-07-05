import { useEffect, useState } from 'react'
import {
  createDomain,
  createTerm,
  deleteDomain,
  deleteTerm,
  getDomains,
  getTerms,
} from '../api/client'
import { useStore } from '../state/store'
import type { Language, Term } from '../types'
import {
  filterTerms,
  sortTerms,
  toggleSort,
  type SortCriterion,
  type SortKey,
} from './termTable'

export function TerminologyView() {
  const domains = useStore((s) => s.domains)
  const setDomains = useStore((s) => s.setDomains)
  const [activeDomainId, setActiveDomainId] = useState<number | null>(null)
  const [terms, setTerms] = useState<Term[]>([])
  const [newDomain, setNewDomain] = useState('')

  const refreshDomains = () => getDomains().then(setDomains)

  useEffect(() => {
    void refreshDomains()
  }, [])

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
    const domain = await createDomain(newDomain.trim())
    setNewDomain('')
    await refreshDomains()
    setActiveDomainId(domain.id)
  }

  async function removeDomain(id: number) {
    await deleteDomain(id)
    if (activeDomainId === id) setActiveDomainId(null)
    await refreshDomains()
  }

  return (
    <div className="terminology">
      <aside className="domain-list">
        <h2>Domains</h2>
        {domains.map((domain) => (
          <div
            key={domain.id}
            className={`domain-row${domain.id === activeDomainId ? ' selected' : ''}`}
            onClick={() => setActiveDomainId(domain.id)}
          >
            <span>{domain.name}</span>
            <button
              className="icon-button"
              title="Delete domain"
              onClick={(event) => {
                event.stopPropagation()
                void removeDomain(domain.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="add-domain">
          <input
            value={newDomain}
            placeholder="New domain…"
            onChange={(event) => setNewDomain(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void addDomain()}
          />
          <button onClick={() => void addDomain()}>Add</button>
        </div>
      </aside>
      {activeDomainId !== null && (
        <TermTable
          domainId={activeDomainId}
          terms={terms}
          onChanged={() => getTerms(activeDomainId).then(setTerms)}
        />
      )}
    </div>
  )
}

interface TermTableProps {
  domainId: number
  terms: Term[]
  onChanged: () => void
}

function TermTable({ domainId, terms, onChanged }: TermTableProps) {
  const languages = useStore((s) => s.languages)
  const [language, setLanguage] = useState<Language>('en')
  const [preferred, setPreferred] = useState('')
  const [variants, setVariants] = useState('')
  const [definition, setDefinition] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([])
  const [languageFilter, setLanguageFilter] = useState<Language | null>(null)
  const [query, setQuery] = useState('')

  const visibleTerms = sortTerms(filterTerms(terms, languageFilter, query), sortCriteria)

  function onToggleSort(key: SortKey) {
    setSortCriteria((old) => toggleSort(old, key))
  }

  async function addTerm() {
    if (!preferred.trim()) return
    await createTerm(domainId, {
      language,
      preferred: preferred.trim(),
      forbidden_variants: variants
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      definition: definition.trim(),
      case_sensitive: caseSensitive,
    })
    setPreferred('')
    setVariants('')
    setDefinition('')
    onChanged()
  }

  return (
    <section className="term-table">
      <h2>Terms</h2>
      <div className="term-toolbar">
        <input
          type="search"
          className="term-search"
          value={query}
          placeholder="Search terms…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="term-language-filter"
          value={languageFilter ?? ''}
          title="Show only terms of one language"
          onChange={(event) =>
            setLanguageFilter(event.target.value === '' ? null : (event.target.value as Language))
          }
        >
          <option value="">All languages</option>
          {languages.map((info) => (
            <option key={info.code} value={info.code}>
              {info.code}
            </option>
          ))}
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <SortableHeader label="Lang" sortKey="language" criteria={sortCriteria} onToggle={onToggleSort} />
            <SortableHeader label="Preferred" sortKey="preferred" criteria={sortCriteria} onToggle={onToggleSort} />
            <SortableHeader label="Do not use" sortKey="forbidden" criteria={sortCriteria} onToggle={onToggleSort} />
            <th>Definition</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleTerms.length === 0 && terms.length > 0 && (
            <tr className="no-terms-row">
              <td colSpan={5}>No terms match the current filter.</td>
            </tr>
          )}
          {visibleTerms.map((term) => (
            <tr key={term.id}>
              <td>{term.language}</td>
              <td>{term.preferred}</td>
              <td>{term.forbidden_variants.join(', ')}</td>
              <td>{term.definition}</td>
              <td>
                <button
                  className="icon-button"
                  title="Delete term"
                  onClick={() => deleteTerm(term.id).then(onChanged)}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          <tr className="add-term">
            <td>
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value as Language)}
              >
                {languages.map((info) => (
                  <option key={info.code} value={info.code}>
                    {info.code}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <input
                value={preferred}
                placeholder="preferred term"
                onChange={(event) => setPreferred(event.target.value)}
              />
            </td>
            <td>
              <input
                value={variants}
                placeholder="forbidden, comma-separated"
                onChange={(event) => setVariants(event.target.value)}
              />
            </td>
            <td>
              <input
                value={definition}
                placeholder="definition (optional)"
                onChange={(event) => setDefinition(event.target.value)}
              />
            </td>
            <td>
              <label className="case-label">
                <input
                  type="checkbox"
                  checked={caseSensitive}
                  onChange={(event) => setCaseSensitive(event.target.checked)}
                />
                Aa
              </label>
              <button onClick={() => void addTerm()}>Add</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}

interface SortableHeaderProps {
  label: string
  sortKey: SortKey
  criteria: SortCriterion[]
  onToggle: (key: SortKey) => void
}

function SortableHeader({ label, sortKey, criteria, onToggle }: SortableHeaderProps) {
  const index = criteria.findIndex((c) => c.key === sortKey)
  const direction = index >= 0 ? criteria[index].direction : null
  return (
    <th
      className={`sortable${direction ? ' sorted' : ''}`}
      title="Click to sort: ascending → descending → off"
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
