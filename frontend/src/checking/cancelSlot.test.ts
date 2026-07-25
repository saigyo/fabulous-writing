// @vitest-environment happy-dom
import { describe, it } from 'vitest'

describe('checking/controller <-> auth/session module load order', () => {
  it('importing auth/session before checking/controller does not throw', async () => {
    // Regression for a real crash, not a hypothetical one: before
    // checking/cancelSlot.ts existed, controller.ts registered its handler
    // directly into a `let` declared in session.ts. That closes a cycle —
    // session.ts -> documents.ts -> documents/hydration.ts ->
    // checking/controller.ts -> auth/session.ts — and whichever module is
    // reached *second* finds the other's slot still in its temporal dead
    // zone. Today controller.ts is the only importer of session.ts, so the
    // cycle is always entered through controller.ts first and never
    // crashes — but Task 7's LoginGate imports session.ts directly, which
    // can easily put session.ts first in the entry point's depth-first
    // module evaluation. This test forces that exact ordering: a fresh
    // module registry (vitest isolates per test file) that reaches
    // auth/session.ts, and everything it pulls in transitively, before
    // anything has touched checking/controller.ts.
    await import('../auth/session')
    await import('../checking/controller')
  })
})
