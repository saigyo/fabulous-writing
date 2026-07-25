import { getMe, HttpError, postLogin, setUnauthorizedHandler } from '../api/client'
import { clearLegacyText, invalidateDocumentWork } from '../documents/documents'
import { clearSnapshot, readSnapshot } from '../documents/buffer'
import { resetSessionState, useStore } from '../state/store'

// Injected by checking/controller.ts at module load (avoids a module
// cycle): session.ts must not import controller.ts to get cancelCheck(),
// because documents.ts (imported below) already reaches controller.ts
// indirectly via hydration.ts. Defaults to a no-op so a call before
// controller.ts has registered itself never throws.
let cancelInFlightCheck: () => void = () => {}
export function setCancelCheckHandler(fn: () => void): void {
  cancelInFlightCheck = fn
}

/** Discards the buffered document unless it belongs to the user now signing
 * in — including a buffer with no ownerId at all (written by an older
 * build, or the pre-multi-document legacy key), which is treated as
 * foreign rather than assumed safe. */
function discardForeignBuffer(userId: number): void {
  const snapshot = readSnapshot()
  if (snapshot && snapshot.ownerId === userId) return
  clearSnapshot()
  clearLegacyText()
}

/** Bumped by every session transition. A completion that started under an
 *  older generation no longer speaks for anyone and must not commit. */
let generation = 0
export const sessionGeneration = (): number => generation

export async function login(email: string, password: string): Promise<boolean> {
  const startedAt = generation
  const previousUserId = useStore.getState().user?.id
  const { token, user } = await postLogin(email, password)
  // Someone logged out while this was in flight — drop the token on the floor
  // rather than signing a deliberately logged-out user back in.
  if (startedAt !== generation) return false
  generation++
  // Purge is for a *user change*, per Decision 1. Re-authenticating as the
  // same person — which Task 8 does silently after a password change — must
  // not wipe their locale, current document and collapse states.
  if (previousUserId !== user.id) resetSessionState()
  discardForeignBuffer(user.id)   // keeps this user's own unsaved work
  useStore.setState({ sessionExpired: false, restoreFailed: false })
  useStore.getState().setAuth(token, user)
  return true
}

/** Deliberate exit. The machine may be handed over, so nothing survives. */
export function logout(): void {
  generation++
  invalidateDocumentWork()   // first: pending saves must not write the buffer back
  cancelInFlightCheck()
  resetSessionState()
  clearSnapshot()
  clearLegacyText()
  useStore.getState().setAuth(null, null)
}

/** The token stopped working. The same user is almost certainly coming back,
 *  so the document buffer is deliberately left alone — it is the only copy of
 *  their unsaved text, and Task 6's notice promises it in seven languages. */
export function expireSession(): void {
  generation++
  invalidateDocumentWork()   // the buffer survives; the work that rewrites it must not
  cancelInFlightCheck()
  resetSessionState()
  useStore.setState({ sessionExpired: true })
  useStore.getState().setAuth(null, null)
}

let restoreInFlight: Promise<void> | null = null

/** Idempotent while in flight: <StrictMode> double-invokes mount effects, so
 * without this the gate (Task 7) would issue two concurrent /api/auth/me
 * requests. The dedup lives here, with the function, so every caller
 * benefits. */
export function restoreSession(): Promise<void> {
  restoreInFlight ??= runRestore().finally(() => {
    restoreInFlight = null
  })
  return restoreInFlight
}

async function runRestore(): Promise<void> {
  const token = useStore.getState().token
  if (!token) {
    useStore.getState().setAuth(null, null)
    return
  }
  try {
    useStore.getState().setAuth(token, await getMe())
  } catch (error) {
    // Only an authentication rejection ends the session. A 500 or a dropped
    // connection during startup must NOT discard a perfectly good token —
    // that would turn a backend hiccup into a logout, and the spec scopes
    // auth-clearing to 401 alone.
    if (error instanceof HttpError && error.status === 401) {
      expireSession()
      return
    }
    useStore.setState({ restoreFailed: true })   // authStatus stays 'unknown'
  }
}

// Registers expireSession as the handler client.ts calls on a 401 (wired up
// starting Task 4). client.ts must not import session.ts back — see its own
// setUnauthorizedHandler comment.
setUnauthorizedHandler(expireSession)
