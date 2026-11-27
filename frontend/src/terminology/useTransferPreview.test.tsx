// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../api/client'
import type { TransferOutcome } from '../types'
import { useTransferPreview } from './useTransferPreview'

const outcome = (n: number) => ({ moved: [{ id: n }] }) as unknown as TransferOutcome

function deferred() {
  let resolve!: (o: TransferOutcome) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<TransferOutcome>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(cleanup)

describe('useTransferPreview', () => {
  it('is idle without a request', () => {
    const { result } = renderHook(() => useTransferPreview(null))
    expect(result.current).toMatchObject({ outcome: null, loading: false, error: null })
  })

  it('loads, then delivers the outcome', async () => {
    const d = deferred()
    const run = () => d.promise
    const { result } = renderHook(() => useTransferPreview(run))
    expect(result.current.loading).toBe(true)
    await act(async () => d.resolve(outcome(1)))
    expect(result.current.loading).toBe(false)
    expect(result.current.outcome).toEqual(outcome(1))
    expect(result.current.error).toBeNull()
  })

  it('delivers an error', async () => {
    const error = new HttpError(409, 'nope')
    const run = () => Promise.reject(error)
    const { result } = renderHook(() => useTransferPreview(run))
    await waitFor(() => expect(result.current.error).toBe(error))
    expect(result.current).toMatchObject({ outcome: null, loading: false })
  })

  it('ignores the late answer of an earlier request', async () => {
    const first = deferred()
    const second = deferred()
    const runFirst = () => first.promise
    const runSecond = () => second.promise
    const { result, rerender } = renderHook(({ run }) => useTransferPreview(run), {
      initialProps: { run: runFirst },
    })
    rerender({ run: runSecond })
    expect(result.current.loading).toBe(true)
    await act(async () => second.resolve(outcome(2)))
    await act(async () => first.resolve(outcome(1)))
    expect(result.current.outcome).toEqual(outcome(2))
    expect(result.current.loading).toBe(false)
  })

  it('clears the previous outcome when a new request starts', async () => {
    const d = deferred()
    const first = () => Promise.resolve(outcome(1))
    const second = () => d.promise
    const { result, rerender } = renderHook(({ run }) => useTransferPreview(run), {
      initialProps: { run: first },
    })
    await waitFor(() => expect(result.current.outcome).toEqual(outcome(1)))
    rerender({ run: second })
    expect(result.current).toMatchObject({ outcome: null, error: null, loading: true })
    await act(async () => d.resolve(outcome(2)))
  })

  it('clears everything for null', async () => {
    const run = () => Promise.resolve(outcome(1))
    const { result, rerender } = renderHook(({ run }) => useTransferPreview(run), {
      initialProps: { run: run as (() => Promise<TransferOutcome>) | null },
    })
    await waitFor(() => expect(result.current.outcome).not.toBeNull())
    rerender({ run: null })
    expect(result.current).toMatchObject({ outcome: null, loading: false, error: null })
  })

  it('repeats the request on reload and clears the earlier error', async () => {
    const run = vi
      .fn<() => Promise<TransferOutcome>>()
      .mockRejectedValueOnce(new HttpError(500, 'boom'))
      .mockResolvedValueOnce(outcome(3))
    const { result } = renderHook(() => useTransferPreview(run))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    act(() => result.current.reload())
    expect(result.current).toMatchObject({ error: null, loading: true })
    await waitFor(() => expect(result.current.outcome).toEqual(outcome(3)))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not request again for the same run on a re-render', async () => {
    const run = vi.fn(() => Promise.resolve(outcome(1)))
    const { result, rerender } = renderHook(() => useTransferPreview(run))
    await waitFor(() => expect(result.current.outcome).not.toBeNull())
    rerender()
    rerender()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps the answer after a reload when the answer from before it arrives late', async () => {
    const before = deferred()
    const after = deferred()
    const run = vi.fn<() => Promise<TransferOutcome>>().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    const { result } = renderHook(() => useTransferPreview(run))
    act(() => result.current.reload())
    await act(async () => after.resolve(outcome(2)))
    await act(async () => before.resolve(outcome(1)))
    expect(result.current.outcome).toEqual(outcome(2))
    expect(result.current.loading).toBe(false)
  })

  it('keeps the error after a reload when the error from before it arrives late', async () => {
    const before = deferred()
    const after = deferred()
    const run = vi.fn<() => Promise<TransferOutcome>>().mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    const { result } = renderHook(() => useTransferPreview(run))
    act(() => result.current.reload())
    const error = new HttpError(409, 'later')
    await act(async () => after.reject(error))
    await act(async () => before.reject(new HttpError(409, 'earlier')))
    expect(result.current.error).toBe(error)
  })
})
