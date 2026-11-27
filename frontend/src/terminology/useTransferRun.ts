import { useState } from 'react'
import type { HttpError } from '../api/client'
import type { TransferBasis, TransferOutcome } from '../types'
import { withComment } from './conceptDraft'
import { messageOf } from './transfer'

type Send = (body: { basis: TransferBasis; comment?: string }) => Promise<TransferOutcome>

/** The real run of a merge or move: after success it stays running, because its opener closes the dialog. */
export function useTransferRun(comment: string, onDone: (outcome: TransferOutcome) => void, reload: () => void) {
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [outdatedId, setOutdatedId] = useState<number | null>(null)

  const clear = () => {
    setRunError(null)
    setOutdatedId(null)
  }

  /** `outdatedFallback`: the concept named when an out-of-date refusal carries no concept id. */
  const confirm = async (
    outcome: TransferOutcome,
    send: Send,
    outdatedFallback: number,
    describe: (failure: HttpError) => string = messageOf,
  ) => {
    setRunning(true)
    clear()
    try {
      onDone(await send({ basis: outcome.basis, ...withComment(comment) }))
    } catch (caught) {
      setRunning(false)
      const failure = caught as HttpError
      if (failure.code === 'outdated') {
        setOutdatedId(failure.conceptId ?? outdatedFallback)
        reload()
      } else {
        setRunError(describe(failure))
      }
    }
  }

  return { running, runError, outdatedId, clear, confirm }
}
