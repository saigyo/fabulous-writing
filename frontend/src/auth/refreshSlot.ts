/**
 * Registration slot so checking/controller.ts and checking/suggest.ts can
 * trigger a /me re-fetch without importing auth/session.ts — the same
 * cycle-breaking pattern (and the same cycle: controller -> session ->
 * documents -> hydration -> controller) as checking/cancelSlot.ts, which
 * see for the full explanation.
 */
let handler: (() => Promise<void>) | null = null

export function setRefreshUserHandler(fn: () => Promise<void>): void {
  handler = fn
}

export function refreshUserNow(): void {
  void handler?.()
}
