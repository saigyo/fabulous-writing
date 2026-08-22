// Registration slot so auth/session.ts can notify the embed's host-document
// shim (hostDoc.ts) of a successful login without importing hostDoc.ts
// itself — same bundle-boundary-breaking pattern as disconnectSlot.ts (see
// its own comment for why a direct import would pull hostDoc.ts/EmbedApp.tsx
// into the main app's bundle).
let handler: () => void = () => {}

export function setEmbedActivateHandler(fn: () => void): void {
  handler = fn
}

/** Notifies the embed's host-document shim that a login just committed
 * (auth/session.ts's login()) — a no-op in the main app, or in an embed
 * page before main.tsx has registered a handler. A field can connect while
 * the login form is still showing (the bridge attaches regardless of auth
 * status), and a cross-user login's resetSessionState() clears
 * store.connectedField/tracked/docWords/docChars even though the shim is
 * still connected. Without this, the strip shows "waiting" forever after
 * login and the promised connect-time check never re-fires. */
export function activateEmbed(): void {
  handler()
}
