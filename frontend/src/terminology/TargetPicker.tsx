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
  /** The caption stays the field's accessible name but is not shown. */
  hideCaption?: boolean
  /** The field takes the focus when the dialog around it opens. */
  autoFocus?: boolean
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : part.text))}
    </>
  )
}

export function TargetPicker({
  candidates,
  language,
  order,
  target,
  onPick,
  disabled,
  hideCaption = false,
  autoFocus = false,
}: TargetPickerProps) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const change = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (target === null) input.current?.focus()
    else change.current?.focus()
  }, [target])

  const pick = (concept: Concept | null) => {
    refocus.current = true
    onPick(concept)
  }

  if (target !== null) {
    const label = suggestionRow(target, language, order).label
    return (
      <div className="target-picker">
        <div className={hideCaption ? 'visually-hidden' : 'target-caption'}>{m.transferInto}</div>
        <div className="target-field">
          <span className="target-picked">{label.text}</span>
          <button
            ref={change}
            type="button"
            className="link-button"
            disabled={disabled}
            onClick={() => {
              setQuery('')
              setActive(0)
              pick(null)
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
  const listId = `${id}-list`
  const shown = rows.length > 0

  const moveTo = (index: number) => {
    setActive(index)
    const row = rows[index]
    if (row) document.getElementById(optionId(row.id))?.scrollIntoView?.({ block: 'nearest' })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // While an input method composes, Enter commits the text and the arrows pick candidates.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(Math.min(current + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (rows[current]) pick(rows[current])
    }
  }

  return (
    <div className="target-picker">
      <label className={hideCaption ? 'visually-hidden' : 'target-caption'} htmlFor={`${id}-input`}>
        {m.transferInto}
      </label>
      <div className="target-field">
        <input
          ref={input}
          id={`${id}-input`}
          role="combobox"
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-activedescendant={rows[current] ? optionId(rows[current].id) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          data-autofocus={autoFocus || undefined}
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
      {shown ? (
        <div className="target-suggest" id={listId} role="listbox" aria-label={m.transferInto}>
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
                onClick={() => pick(concept)}
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
      ) : (
        <div className="target-suggest target-none">{m.noConceptMatches}</div>
      )}
    </div>
  )
}
