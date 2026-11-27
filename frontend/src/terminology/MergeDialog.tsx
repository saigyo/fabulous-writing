import { useMemo, useState } from 'react'
import { mergeConcept } from '../api/client'
import { useMessages } from '../i18n'
import { languageName } from '../languages'
import { useStore } from '../state/store'
import type { Concept, Language, TransferOutcome } from '../types'
import { Dialog } from '../ui/Dialog'
import { conceptLabel } from './labels'
import { StatusChip } from './StatusChip'
import { TargetPicker } from './TargetPicker'
import { messageOf, notices, resultRows } from './transfer'
import { Quoted, TransferButtons } from './transferParts'
import { useTransferPreview } from './useTransferPreview'
import { useTransferRun } from './useTransferRun'

interface MergeDialogProps {
  source: Concept
  candidates: Concept[]
  language: Language
  order: Language[]
  comment: string
  onDone: (outcome: TransferOutcome) => void
  onClose: () => void
}

export function MergeDialog({
  source,
  candidates,
  language,
  order,
  comment,
  onDone,
  onClose,
}: MergeDialogProps) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const [target, setTarget] = useState<Concept | null>(null)

  const run = useMemo(
    () =>
      target === null ? null : () => mergeConcept(source.id, { target_id: target.id, preview: true }),
    [source.id, target],
  )
  const { outcome, loading, error, reload } = useTransferPreview(run)
  const { running, runError, outdatedId, clear, confirm } = useTransferRun(comment, onDone, reload)

  const label = (concept: Concept) => conceptLabel(concept, language, order).text
  const sourceLabel = label(source)

  const merge = () => {
    if (target === null || outcome === null) return
    void confirm(outcome, (body) => mergeConcept(source.id, { target_id: target.id, ...body }), target.id)
  }

  const pick = (concept: Concept | null) => {
    setTarget(concept)
    clear()
  }

  const taken = outcome === null ? [] : notices(outcome, 'merge')

  return (
    <Dialog
      title={m.mergeTitle(sourceLabel)}
      onClose={onClose}
      locked={running}
      className="merge-dialog"
    >
      <p>{m.mergeIntro(sourceLabel)}</p>
      <TargetPicker
        candidates={candidates}
        language={language}
        order={order}
        target={target}
        onPick={pick}
        disabled={running}
        autoFocus
      />
      {outdatedId !== null && target !== null && (
        <div className="transfer-error">
          {m.transferOutdated(label(outdatedId === source.id ? source : target))}
        </div>
      )}
      {loading && <div className="transfer-wait">{m.transferWorking}</div>}
      {error !== null && <div className="transfer-error">{messageOf(error)}</div>}
      {runError !== null && <div className="transfer-error">{runError}</div>}
      {outcome !== null && (
        <>
          <div className="transfer-result">
            {resultRows(outcome, order).map((row) => (
              <div key={row.language} className="transfer-result-row">
                <span className="language-marker" title={languageName(row.language, languages)}>
                  {row.language.toUpperCase()}
                </span>
                <div>
                  {row.terms.map(({ term, incoming }) => (
                    <StatusChip key={term.id} term={term} incoming={incoming} />
                  ))}
                </div>
                {row.demoted.map((text) => (
                  <div key={text} className="transfer-result-note">
                    {m.transferDemoted(text)}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {taken.length > 0 && (
            <div className="transfer-box">
              <h3>{m.transferNotTakenOver}</h3>
              <ul>
                {taken.map((notice, i) => (
                  <li key={i}>
                    {notice.kind === 'droppedTerm' &&
                      m.transferDroppedTerm(
                        notice.text,
                        notice.language.toUpperCase(),
                        m.statusName(notice.usageStatus),
                        target ? label(target) : '',
                      )}
                    {notice.kind === 'droppedDefinition' && (
                      <Quoted
                        sentence={m.transferDroppedDefinition(
                          languageName(notice.language, languages),
                          m.quoted(notice.definition),
                          target ? label(target) : '',
                        )}
                        quote={m.quoted(notice.definition)}
                      />
                    )}
                    {notice.kind === 'droppedDomain' && m.transferDroppedDomain(notice.name)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {outcome.added_domains.map((domain) => (
            <div key={domain.id} className="transfer-also">
              {m.mergeAddedDomain(domain.name)}
            </div>
          ))}
        </>
      )}
      <TransferButtons
        running={running}
        ready={outcome !== null}
        danger
        label={m.mergeConfirm(sourceLabel)}
        onCancel={onClose}
        onConfirm={merge}
      />
    </Dialog>
  )
}
