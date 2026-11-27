import { useEffect, useId, useRef, useState } from 'react'
import { useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Concept, Language } from '../types'
import { highlight, suggest, suggestionRow } from './transfer'

interface TargetPickerProps {
  candidates: Concept[]
  language: Language
  order: Language[]
  target: Concept | null
  onPick: (concept: Concept | null) => void
  disabled: boolean
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : part.text))}
    </>
  )
}

export function TargetPicker({ candidates, language, order, target, onPick, disabled }: TargetPickerProps) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const refocus = useRef(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (target === null && refocus.current) {
      refocus.current = false
      input.current?.focus()
    }
  }, [target])

  if (target !== null) {
    const label = suggestionRow(target, language, order).label
    return (
      <div className="target-picker">
        <div className="target-caption">{m.transferInto}</div>
        <div className="target-field">
          <span className="target-picked">{label.text}</span>
          <button
            type="button"
            className="link-button"
            disabled={disabled}
            onClick={() => {
              refocus.current = true
              setQuery('')
              setActive(0)
              onPick(null)
            }}
          >
            {m.transferChange}
          </button>
        </div>
      </div>
    )
  }

  const rows = suggest(candidates, query, language, order)
  const current = Math.min(active, Math.max(rows.length - 1, 0))
  const optionId = (conceptId: number) => `${id}-option-${conceptId}`

  const moveTo = (index: number) => {
    setActive(index)
    const row = rows[index]
    if (row) document.getElementById(optionId(row.id))?.scrollIntoView?.({ block: 'nearest' })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(Math.min(current + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (rows[current]) onPick(rows[current])
    }
  }

  return (
    <div className="target-picker">
      <label className="target-caption" htmlFor={`${id}-input`}>
        {m.transferInto}
      </label>
      <div className="target-field">
        <input
          ref={input}
          id={`${id}-input`}
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={rows[current] ? optionId(rows[current].id) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          disabled={disabled}
          placeholder={m.searchConceptsPlaceholder}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="target-suggest" id={`${id}-list`} role="listbox" aria-label={m.transferInto}>
        {rows.length === 0 && <div className="target-none">{m.noConceptMatches}</div>}
        {rows.map((concept, index) => {
          const row = suggestionRow(concept, language, order)
          return (
            <div
              key={concept.id}
              id={optionId(concept.id)}
              role="option"
              aria-selected={index === current}
              className={`target-option${index === current ? ' active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(concept)}
            >
              <span className="target-option-label">
                {row.label.fallback && (
                  <span className="language-marker" title={languageName(row.label.language, languages)}>
                    {row.label.language.toUpperCase()}
                  </span>
                )}
                <span className="target-option-text">
                  <Highlighted text={row.label.text} query={query} />
                </span>
              </span>
              <span className="target-option-others">
                {row.others.map((term, i) => (
                  <span key={term.id}>
                    {i > 0 && ' · '}
                    <Highlighted text={term.text} query={query} />
                  </span>
                ))}
              </span>
              <span>
                {row.languages.map((code) => (
                  <span key={code} className="language-marker" title={languageName(code, languages)}>
                    {code.toUpperCase()}
                  </span>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
