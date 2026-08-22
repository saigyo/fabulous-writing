// Registration slot so auth/session.ts can reset the embed's host-document
// shim (hostDoc.ts) on session teardown without importing hostDoc.ts itself
// — the same cycle/bundle-boundary-breaking pattern as checking/cancelSlot.ts
// and auth/refreshSlot.ts (see cancelSlot.ts for the full explanation of why
// a direct import would close a cycle). Here the concern is bundle
// direction rather than a load-order cycle: auth/session.ts is reachable
// from the MAIN app's entry too, and hostDoc.ts/EmbedApp.tsx must stay
// reachable only from the embed entry (scripts/check-embed-bundle.mjs's
// concern, one level up the import graph) — so the dependency must point
// from the embed entry (main.tsx) inward to this slot, never the reverse.
let handler: () => void = () => {}

export function setEmbedDisconnectHandler(fn: () => void): void {
  handler = fn
}

/** Resets the embed's host-document shim on session teardown (logout /
 * expireSession, auth/session.ts) — a no-op in the main app, or in an embed
 * page before main.tsx has registered a handler. Without this, the shim's
 * private fieldId/buffer/items survive a logout and the first textChanged
 * after a re-login republishes pre-logout findings. */
export function disconnectEmbed(): void {
  handler()
}
