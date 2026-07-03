export interface CheckSchedulerOptions {
  fastDelayMs: number
  llmDelayMs: number
  onFast: () => void
  onFull: () => void
  llmEnabled: () => boolean
}

export interface CheckScheduler {
  onInput: () => void
  checkNow: () => void
  dispose: () => void
}

/**
 * Debounces checking: the fast (rules/terminology) check runs shortly after
 * typing pauses, the full check (including the LLM) after a longer pause.
 */
export function createCheckScheduler(options: CheckSchedulerOptions): CheckScheduler {
  let fastTimer: ReturnType<typeof setTimeout> | null = null
  let llmTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers() {
    if (fastTimer !== null) clearTimeout(fastTimer)
    if (llmTimer !== null) clearTimeout(llmTimer)
    fastTimer = null
    llmTimer = null
  }

  return {
    onInput() {
      clearTimers()
      fastTimer = setTimeout(options.onFast, options.fastDelayMs)
      if (options.llmEnabled()) {
        llmTimer = setTimeout(options.onFull, options.llmDelayMs)
      }
    },
    checkNow() {
      clearTimers()
      options.onFull()
    },
    dispose: clearTimers,
  }
}
