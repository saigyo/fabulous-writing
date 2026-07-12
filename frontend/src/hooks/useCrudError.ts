import { useState } from 'react'

/** Shared mutation wrapper for CRUD views: formats a thrown error via the
 * given message fn, clears it on the next success. */
export function useCrudError(format: (message: string) => string) {
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(format(e instanceof Error ? e.message : String(e)))
    }
  }
  return { error, run }
}
