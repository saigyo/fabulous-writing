import { useId, useMemo, useState } from 'react'
import { moveTerm, type HttpError } from '../api/client'
import { useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Concept, ConceptTerm, Language, TransferOutcome } from '../types'
import { Dialog } from '../ui/Dialog'
import { conceptLabel } from './labels'
import { TargetPicker } from './TargetPicker'
import { messageOf, notices, sourceIsCurrent, type Notice } from './transfer'
import { Quoted, TransferButtons } from './transferParts'
import { useTransferPreview } from './useTransferPreview'
import { useTransferRun } from './useTransferRun'

interface MoveDialogProps {
  source: Concept
  term: ConceptTerm
  candidates: Concept[]
  language: Language
  order: Language[]
  comment: string
  canCreate: boolean
  onDone: (outcome: TransferOutcome) => void
  onClose: () => void
}

type Choice = 'concept' | 'new'

export function MoveDialog({
  source,
  term,
  candidates,
  language,
  order,
  comment,
  canCreate,
  onDone,
  onClose,
}: MoveDialogProps) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const groupName = useId()
  const [choice, setChoice] = useState<Choice>('concept')
  const [target, setTarget] = useState<Concept | null>(null)

  const targetId = choice === 'new' ? null : (target?.id ?? undefined)
  const run = useMemo(
    () =>
      targetId === undefined ? null : () => moveTerm(term.id, { target_id: targetId, preview: true }),
    [term.id, targetId],
  )
  const { outcome: previewed, loading, error, reload } = useTransferPreview(run)
  const { running, runError, outdatedId, clear, confirm } = useTransferRun(comment, onDone, reload)

  const stale = previewed !== null && !sourceIsCurrent(source, previewed)
  const outcome = stale ? null : previewed

  const label = (concept: Concept) => conceptLabel(concept, language, order).text
  const sourceLabel = label(source)
  const termLanguage = source.sections.find((s) => s.terms.some((t) => t.id === term.id))?.language
  const named = (code: Language) => languageName(code, languages)

  const failureText = (failure: HttpError) =>
    failure.code === 'duplicate_text' && target !== null
      ? m.moveDuplicate(label(target), term.text, named(termLanguage ?? language))
      : messageOf(failure, m)

  const move = () => {
    if (targetId === undefined || outcome === null) return
    void confirm(outcome, (body) => moveTerm(term.id, { target_id: targetId, ...body }), source.id, failureText)
  }

  const choose = (next: Choice) => {
    setChoice(next)
    clear()
  }

  const pick = (concept: Concept | null) => {
    setTarget(concept)
    clear()
  }

  const outdatedLabel = outdatedId === null ? null : label(outdatedId !== source.id && target ? target : source)

  const sentence = (notice: Notice) => {
    switch (notice.kind) {
      case 'demoted':
        return m.transferDemoted(notice.text)
      case 'lostLanguage': {
        const name = named(notice.language)
        if (notice.definition === null) return m.moveLostLanguage(sourceLabel, name)
        const quote = m.quoted(notice.definition)
        return <Quoted sentence={m.moveLostLanguageDefinition(sourceLabel, name, quote)} quote={quote} />
      }
      case 'droppedDefinition': {
        const quote = m.quoted(notice.definition)
        return <Quoted sentence={m.moveDefinitionDropped(named(notice.language), quote)} quote={quote} />
      }
      case 'droppedDomain':
        return m.moveDroppedDomain(notice.name)
      case 'addedDomain':
        return m.moveAddedDomain(notice.name)
      case 'sourceDeleted':
        return m.moveSourceDeleted
      case 'droppedTerm':
        return null
    }
  }

  const also = outcome === null ? [] : notices(outcome, 'move')

  return (
    <Dialog
      title={m.moveTitle(term.text)}
      onClose={onClose}
      locked={running}
      className="move-dialog"
    >
      <div className="transfer-choice" role="radiogroup" aria-label={m.moveTitle(term.text)}>
        <label>
          <input
            type="radio"
            name={groupName}
            checked={choice === 'concept'}
            disabled={running}
            onChange={() => choose('concept')}
          />
          <span>{m.moveToConcept}</span>
        </label>
        {choice === 'concept' && (
          <div className="transfer-choice-sub">
            <TargetPicker
              candidates={candidates}
              language={language}
              order={order}
              target={target}
              onPick={pick}
              disabled={running}
              hideCaption
              autoFocus
            />
          </div>
        )}
        {canCreate && (
          <label>
            <input
              type="radio"
              name={groupName}
              checked={choice === 'new'}
              disabled={running}
              onChange={() => choose('new')}
            />
            <span>{m.moveToNew}</span>
          </label>
        )}
      </div>
      {choice === 'new' && <div className="transfer-also">{m.moveNewConceptDomains(sourceLabel)}</div>}
      {outdatedLabel !== null && <div className="transfer-error">{m.transferOutdated(outdatedLabel)}</div>}
      {loading && <div className="transfer-wait">{m.transferWorking}</div>}
      {error !== null && (
        <div className="transfer-error">
          {error.code === 'outdated'
            ? m.transferOutdatedPreview(label(error.conceptId !== source.id && target ? target : source))
            : failureText(error)}
        </div>
      )}
      {stale && <div className="transfer-error">{m.transferOutdatedPreview(sourceLabel)}</div>}
      {runError !== null && <div className="transfer-error">{runError}</div>}
      {also.length > 0 && (
        <div className="transfer-box">
          <h3>{m.moveAlso}</h3>
          <ul>
            {also.map((notice, i) => (
              <li key={i}>{sentence(notice)}</li>
            ))}
          </ul>
        </div>
      )}
      <TransferButtons
        running={running}
        ready={outcome !== null}
        danger={false}
        label={m.moveConfirm}
        onCancel={onClose}
        onConfirm={move}
      />
    </Dialog>
  )
}
