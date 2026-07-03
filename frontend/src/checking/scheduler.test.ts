import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCheckScheduler } from './scheduler'

describe('createCheckScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(llmEnabled = true) {
    const onFast = vi.fn()
    const onFull = vi.fn()
    const scheduler = createCheckScheduler({
      fastDelayMs: 1000,
      llmDelayMs: 5000,
      onFast,
      onFull,
      llmEnabled: () => llmEnabled,
    })
    return { scheduler, onFast, onFull }
  }

  it('runs the fast check 1s after the last input', () => {
    const { scheduler, onFast } = setup()
    scheduler.onInput()
    vi.advanceTimersByTime(900)
    scheduler.onInput()
    vi.advanceTimersByTime(900)
    expect(onFast).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onFast).toHaveBeenCalledTimes(1)
  })

  it('runs the full check 5s after the last input when LLM is enabled', () => {
    const { scheduler, onFull } = setup()
    scheduler.onInput()
    vi.advanceTimersByTime(4999)
    expect(onFull).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFull).toHaveBeenCalledTimes(1)
  })

  it('does not schedule the full check when LLM is disabled', () => {
    const { scheduler, onFull } = setup(false)
    scheduler.onInput()
    vi.advanceTimersByTime(10000)
    expect(onFull).not.toHaveBeenCalled()
  })

  it('checkNow triggers the full check immediately and cancels pending timers', () => {
    const { scheduler, onFast, onFull } = setup()
    scheduler.onInput()
    scheduler.checkNow()
    expect(onFull).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10000)
    expect(onFull).toHaveBeenCalledTimes(1)
    expect(onFast).not.toHaveBeenCalled()
  })

  it('dispose cancels all pending checks', () => {
    const { scheduler, onFast, onFull } = setup()
    scheduler.onInput()
    scheduler.dispose()
    vi.advanceTimersByTime(10000)
    expect(onFast).not.toHaveBeenCalled()
    expect(onFull).not.toHaveBeenCalled()
  })
})
