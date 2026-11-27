import { useId, useMemo, useState } from 'react'
import { HttpError, moveTerm } from '../api/client'
import { useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Concept, ConceptTerm, Language, TransferOutcome } from '../types'
import { Dialog } from '../ui/Dialog'
import { conceptLabel } from './labels'
import { TargetPicker } from './TargetPicker'
import { messageOf, notices, type Notice } from './transfer'
import { Quoted } from './transferParts'
import { useTransferPreview } from './useTransferPreview'

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
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [outdatedId, setOutdatedId] = useState<number | null>(null)

  const targetId = choice === 'new' ? null : (target?.id ?? undefined)
  const run = useMemo(
    () =>
      targetId === undefined ? null : () => moveTerm(term.id, { target_id: targetId, preview: true }),
    [term.id, targetId],
  )
  const { outcome, loading, error, reload } = useTransferPreview(run)

  const label = (concept: Concept) => conceptLabel(concept, language, order).text
  const sourceLabel = label(source)
  const termLanguage = source.sections.find((s) => s.terms.some((t) => t.id === term.id))?.language
  const named = (code: Language) => languageName(code, languages)

  const failureText = (failure: HttpError) =>
    failure.code === 'duplicate_text' && target !== null
      ? m.moveDuplicate(label(target), term.text, named(termLanguage ?? language))
      : messageOf(failure)

  const clearMessages = () => {
    setRunError(null)
    setOutdatedId(null)
  }

  const confirm = async () => {
    if (targetId === undefined || outcome === null) return
    setRunning(true)
    clearMessages()
    try {
      const done = await moveTerm(term.id, {
        target_id: targetId,
        basis: outcome.basis,
        comment: comment || undefined,
      })
      onDone(done)
    } catch (caught) {
      setRunning(false)
      const failure = caught as HttpError
      if (failure.code === 'outdated') {
        setOutdatedId(failure.conceptId ?? source.id)
        reload()
      } else {
        setRunError(failureText(failure))
      }
    }
  }

  const choose = (next: Choice) => {
    setChoice(next)
    clearMessages()
  }

  const pick = (concept: Concept | null) => {
    setTarget(concept)
    clearMessages()
  }

  const outdatedLabel = outdatedId === null ? null : label(outdatedId !== source.id && target ? target : source)

  const sentence = (notice: Notice) => {
    switch (notice.kind) {
      case 'demoted':
        return m.transferDemoted(notice.text)
      case 'lostLanguage': {
        const name = named(notice.language)
        if (notice.definition === null) return m.moveLostLanguage(sourceLabel, name)
        const quote = `“${notice.definition}”`
        return <Quoted sentence={m.moveLostLanguageDefinition(sourceLabel, name, quote)} quote={quote} />
      }
      case 'droppedDefinition': {
        const quote = `“${notice.definition}”`
        return <Quoted sentence={m.moveDefinitionDropped(named(notice.language), quote)} quote={quote} />
      }
      case 'droppedDomain':
        return m.moveDroppedDomain(notice.name)
      case 'addedDomain':
        return m.moveAddedDomain(notice.name)
      case 'sourceDeleted':
        return m.moveSourceDeleted(sourceLabel)
      case 'droppedTerm':
        return null
    }
  }

  const also = outcome === null ? [] : notices(outcome, 'move')
  const deletesSource = outcome !== null && outcome.source === null

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
      {error !== null && <div className="transfer-error">{failureText(error)}</div>}
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
      <div className="transfer-buttons">
        <button type="button" className="plain-button" disabled={running} onClick={onClose}>
          {m.dialogCancel}
        </button>
        <button
          type="button"
          className={deletesSource ? 'confirm-dialog-danger' : 'primary-button'}
          disabled={outcome === null || running}
          onClick={confirm}
        >
          {deletesSource ? m.moveConfirmDelete(sourceLabel) : m.moveConfirm}
        </button>
      </div>
    </Dialog>
  )
}
