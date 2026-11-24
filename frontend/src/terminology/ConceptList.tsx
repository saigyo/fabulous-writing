import { useState } from 'react'
import { useLocale, useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Concept, Domain, Language } from '../types'
import { conceptLabel, conceptLanguages, matchesQuery, otherWordings, sortByLabel } from './labels'
import { StatusChip } from './StatusChip'

interface ConceptListProps {
  domain: Domain
  concepts: Concept[]
  domains: Domain[]
  readOnly: boolean
  canCreate: boolean
  onOpen: (conceptId: number) => void
  onCreate: (language: Language) => void
}

const STATUSES = ['preferred', 'admitted', 'deprecated', 'forbidden'] as const

export function ConceptList({
  domain,
  concepts,
  domains,
  readOnly,
  canCreate,
  onOpen,
  onCreate,
}: ConceptListProps) {
  const languages = useStore((s) => s.languages)
  const m = useMessages()
  const locale = useLocale()
  const [language, setLanguage] = useState<Language>(locale)
  const [query, setQuery] = useState('')
  const order = languages.map((l) => l.code)

  const visible = sortByLabel(
    concepts.filter((c) => matchesQuery(c, query)),
    language,
    order,
  )

  return (
    <section className="concept-list">
      <div className="concept-controls">
        <h2>{m.concepts}</h2>
        <select
          aria-label={m.conceptLanguageTitle}
          title={m.conceptLanguageTitle}
          value={language}
          onChange={(event) => setLanguage(event.target.value as Language)}
        >
          {languages.map((info) => (
            <option key={info.code} value={info.code}>
              {info.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={query}
          placeholder={m.searchConceptsPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
        {!readOnly && canCreate && (
          <button type="button" onClick={() => onCreate(language)}>
            {m.newConcept}
          </button>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>{m.labelHeader}</th>
            <th>{m.wordingsHeader}</th>
            <th>{m.languagesHeader}</th>
            <th>{m.alsoInHeader}</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && concepts.length > 0 && (
            <tr className="no-concepts-row">
              <td colSpan={4}>{m.noConceptsMatch}</td>
            </tr>
          )}
          {visible.map((concept) => {
            const label = conceptLabel(concept, language, order)
            const alsoIn = concept.domain_ids
              .filter((id) => id !== domain.id)
              .map((id) => domains.find((d) => d.id === id)?.name)
              .filter((name): name is string => name !== undefined)
            return (
              <tr key={concept.id} className="concept-row" onClick={() => onOpen(concept.id)}>
                <td className="concept-label">
                  {label.fallback && (
                    <span className="language-marker" title={languageName(label.language, languages)}>
                      {label.language.toUpperCase()}
                    </span>
                  )}
                  <button type="button" className="concept-open">
                    {label.text || '—'}
                  </button>
                  {label.fallback && (
                    <span className="no-term-note">
                      {m.noTermIn(languageName(language, languages))}
                    </span>
                  )}
                </td>
                <td>
                  {otherWordings(concept, language).map((term) => (
                    <StatusChip key={term.id} term={term} />
                  ))}
                </td>
                <td>
                  {conceptLanguages(concept, order).map((code) => (
                    <span key={code} className="language-marker" title={languageName(code, languages)}>
                      {code.toUpperCase()}
                    </span>
                  ))}
                </td>
                <td>{alsoIn.length > 0 ? alsoIn.join(', ') : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <ul className="status-legend" aria-label={m.statusLegend}>
        {STATUSES.map((status) => (
          <li key={status} className={`status-chip status-${status}`}>
            {m.statusName(status)}
          </li>
        ))}
        <li className="status-chip candidate">{m.statusCandidate}</li>
      </ul>
    </section>
  )
}
