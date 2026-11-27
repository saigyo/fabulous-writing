import { useEffect, useState } from 'react'
import type { HttpError } from '../api/client'
import type { TransferOutcome } from '../types'

type Run = () => Promise<TransferOutcome>

interface Answer {
  run: Run
  round: number
  outcome: TransferOutcome | null
  error: HttpError | null
}

export function useTransferPreview(run: Run | null): {
  outcome: TransferOutcome | null
  loading: boolean
  error: HttpError | null
  reload: () => void
} {
  const [round, setRound] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)

  useEffect(() => {
    if (run === null) return
    let current = true
    run().then(
      (outcome) => {
        if (current) setAnswer({ run, round, outcome, error: null })
      },
      (error: HttpError) => {
        if (current) setAnswer({ run, round, outcome: null, error })
      },
    )
    return () => {
      current = false
    }
  }, [run, round])

  const fresh = run !== null && answer !== null && answer.run === run && answer.round === round
  return {
    outcome: fresh ? answer.outcome : null,
    error: fresh ? answer.error : null,
    loading: run !== null && !fresh,
    reload: () => setRound((r) => r + 1),
  }
}
