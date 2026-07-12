import { useCallback, useState } from 'react'

/** Shared mutation wrapper for CRUD views: formats a thrown error via the
 * given message fn, clears it on the next success. */
export function useCrudError(format: (message: string) => string) {
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      try {
        await action()
        setError(null)
      } catch (e) {
        setError(format(e instanceof Error ? e.message : String(e)))
      }
    },
    [format],
  )
  /** Sets an already-formatted error message directly, for callers with
   * their own try/catch (e.g. a load path alongside a `run`-based save
   * path, which may use a different message formatter than `format`). */
  const fail = useCallback((message: string): void => {
    setError(message)
  }, [])
  const clear = useCallback((): void => {
    setError(null)
  }, [])
  return { error, run, fail, clear }
}
