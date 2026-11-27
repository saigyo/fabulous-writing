import { useId, useState } from 'react'
import { useMessages } from '../i18n'
import type { Messages } from '../i18n/messages'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { PartOfSpeech, ProcessStatus, UsageStatus } from '../types'
import {
  newTerm,
  sectionChanges,
  sectionProblems,
  type SectionProblem,
  type SectionState,
  type TermDraft,
} from './conceptDraft'

interface LanguageSectionEditorProps {
  section: SectionState
  readOnly: boolean
  saving: boolean
  /** Another section that this save would also send has a problem (Reading 11). */
  saveBlocked: boolean
  error: string | null
  conflict: boolean
  onChange: (section: SectionState) => void
  onSave: () => void
  onDiscard: () => void
  onRemove: () => void
  onReload: () => void
  onMoveTerm?: (termId: number) => void
  moveBlocked: boolean
}

const USAGE_STATUSES: UsageStatus[] = ['preferred', 'admitted', 'deprecated', 'forbidden']
const PARTS_OF_SPEECH: PartOfSpeech[] = ['noun', 'verb', 'adjective', 'adverb', 'proper_noun', 'other']

function problemText(problem: SectionProblem, m: Messages): string {
  return {
    empty_text: m.problemEmptyText,
    duplicate_text: m.problemDuplicateText,
    second_preferred: m.problemSecondPreferred,
    no_terms: m.problemNoTerms,
  }[problem]
}

export function LanguageSectionEditor({
  section,
  readOnly,
  saving,
  saveBlocked,
  error,
  conflict,
  onChange,
  onSave,
  onDiscard,
  onRemove,
  onReload,
  onMoveTerm,
  moveBlocked,
}: LanguageSectionEditorProps) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const headingId = useId()
  const name = languageName(section.language, languages)
  const changes = sectionChanges(section)
  const problems = sectionProblems(section)
  const locked = saving || readOnly

  function changeTerm(key: string, change: Partial<TermDraft>) {
    onChange({ ...section, terms: section.terms.map((t) => (t.key === key ? { ...t, ...change } : t)) })
  }

  return (
    <section
      className={`language-section${changes > 0 ? ' unsaved' : ''}`}
      aria-labelledby={headingId}
    >
      <div className="section-head">
        <h3 id={headingId}>{name}</h3>
        {changes > 0 ? (
          <span className="unsaved-marker">● {m.unsavedChanges(changes)}</span>
        ) : (
          section.saved !== null && !readOnly && <span className="saved-marker">✓ {m.sectionSaved}</span>
        )}
        {!readOnly && (
          <>
            {!section.removed && (
              <button type="button" className="link-button" disabled={saving} onClick={onRemove}>
                {m.removeLanguage}
              </button>
            )}
            <button type="button" className="plain-button" disabled={saving || changes === 0} onClick={onDiscard}>
              {m.discard}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={saving || saveBlocked || changes === 0 || problems.length > 0}
              onClick={onSave}
            >
              {m.saveLanguage(name)}
            </button>
          </>
        )}
      </div>
      {error !== null && (
        <p className="entry-error" role="alert">
          <span>{error}</span>
          {conflict && !readOnly && (
            <button type="button" className="plain-button" disabled={saving} onClick={onReload}>
              {m.loadCurrentVersion}
            </button>
          )}
        </p>
      )}
      {changes > 0 &&
        problems.map((problem) => (
          <p key={problem} className="section-problem">
            {problemText(problem, m)}
          </p>
        ))}
      {section.removed ? (
        <p className="section-note">{m.languageRemovedNote}</p>
      ) : (
        <>
          <textarea
            className="section-definition"
            aria-label={m.definitionLabel}
            placeholder={readOnly ? undefined : m.definitionLabel}
            value={section.definition}
            disabled={locked}
            rows={2}
            onChange={(event) => onChange({ ...section, definition: event.target.value })}
          />
          {!readOnly && <p className="section-note">{m.baseFormHint}</p>}
          <div className="term-row term-head" aria-hidden="true">
            <span>{m.termLabel}</span>
            <span>{m.usageStatusLabel}</span>
            <span>{m.processStatusLabel}</span>
            <span>{m.reasonLabel}</span>
          </div>
          {section.terms.map((term) => (
            <TermRow
              key={term.key}
              term={term}
              readOnly={readOnly}
              saving={saving}
              onChange={(change) => changeTerm(term.key, change)}
              onRemove={() =>
                onChange({ ...section, terms: section.terms.filter((t) => t.key !== term.key) })
              }
              onMove={onMoveTerm && term.id != null ? () => onMoveTerm(term.id!) : undefined}
              moveBlocked={moveBlocked}
            />
          ))}
          {!readOnly && (
            <button
              type="button"
              className="link-button"
              disabled={saving}
              onClick={() => onChange({ ...section, terms: [...section.terms, newTerm()] })}
            >
              {m.addTerm}
            </button>
          )}
        </>
      )}
    </section>
  )
}

function TermRow({
  term,
  readOnly,
  saving,
  onChange,
  onRemove,
  onMove,
  moveBlocked,
}: {
  term: TermDraft
  readOnly: boolean
  saving: boolean
  onChange: (change: Partial<TermDraft>) => void
  onRemove: () => void
  onMove?: () => void
  moveBlocked: boolean
}) {
  const m = useMessages()
  const [open, setOpen] = useState(false)
  const locked = saving || readOnly
  const text = term.text.trim()
  const detailsName = text ? m.termDetailsOf(text) : m.termDetails
  const removeName = text ? m.removeTermNamed(text) : m.removeTerm

  return (
    <div className="term-row">
      <input
        aria-label={m.termLabel}
        value={term.text}
        disabled={locked}
        onChange={(event) => onChange({ text: event.target.value })}
      />
      <select
        aria-label={m.usageStatusLabel}
        value={term.usage_status}
        disabled={locked}
        onChange={(event) => onChange({ usage_status: event.target.value as UsageStatus })}
      >
        {USAGE_STATUSES.map((status) => (
          <option key={status} value={status}>
            {m.statusName(status)}
          </option>
        ))}
      </select>
      <select
        aria-label={m.processStatusLabel}
        value={term.process_status ?? 'active'}
        disabled={locked}
        onChange={(event) => onChange({ process_status: event.target.value as ProcessStatus })}
      >
        <option value="active">{m.statusActive}</option>
        <option value="candidate">{m.statusCandidate}</option>
      </select>
      <input
        aria-label={m.reasonLabel}
        placeholder={readOnly ? undefined : m.reasonLabel}
        value={term.status_reason ?? ''}
        disabled={locked}
        onChange={(event) => onChange({ status_reason: event.target.value })}
      />
      <span className="term-actions">
        <button
          type="button"
          className="link-button"
          aria-label={detailsName}
          aria-expanded={open}
          disabled={saving}
          onClick={() => setOpen(!open)}
        >
          {m.termDetails} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
        {!readOnly && (
          <button
            type="button"
            className="icon-button"
            aria-label={removeName}
            title={removeName}
            disabled={saving}
            onClick={onRemove}
          >
            ✕
          </button>
        )}
      </span>
      {open && (
        <div className="term-details">
          <label>
            <span>{m.contextLabel}</span>
            <input
              value={term.context ?? ''}
              disabled={locked}
              onChange={(event) => onChange({ context: event.target.value })}
            />
          </label>
          <label>
            <span>{m.sourceLabel}</span>
            <input
              value={term.source ?? ''}
              disabled={locked}
              onChange={(event) => onChange({ source: event.target.value })}
            />
          </label>
          <label>
            <span>{m.partOfSpeechLabel}</span>
            <select
              value={term.part_of_speech ?? ''}
              disabled={locked}
              onChange={(event) =>
                onChange({ part_of_speech: (event.target.value || null) as PartOfSpeech | null })
              }
            >
              <option value="">{m.partOfSpeechNone}</option>
              {PARTS_OF_SPEECH.map((pos) => (
                <option key={pos} value={pos}>
                  {m.partOfSpeechName(pos)}
                </option>
              ))}
            </select>
          </label>
          <label className="term-match-case">
            <input
              type="checkbox"
              checked={term.case_sensitive ?? false}
              disabled={locked}
              onChange={(event) => onChange({ case_sensitive: event.target.checked })}
            />
            <span>{m.matchCaseLabel}</span>
          </label>
          {onMove && (
            <div className="term-details-foot">
              <button type="button" className="plain-button" disabled={moveBlocked} onClick={onMove}>
                {m.termMove}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
