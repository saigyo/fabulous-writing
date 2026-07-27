import { getMe, HttpError, postLogin, setUnauthorizedHandler } from '../api/client'
import { cancelInFlightCheck } from '../checking/cancelSlot'
import { clearLegacyText, invalidateDocumentWork } from '../documents/documents'
import { clearSnapshot, readSnapshot } from '../documents/buffer'
import { resetSessionState, useStore } from '../state/store'
import { setRefreshUserHandler } from './refreshSlot'

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
  // Reactive counterpart to the generation++ above (see authGeneration's own
  // comment in state/store.ts): a same-user re-login stays on this same
  // branch — resetSessionState() above is skipped for it — so this bump is
  // the ONLY signal mount effects depending on it see when the
  // password-change flow (auth/AccountMenu.tsx) silently re-authenticates
  // the current user while they stay mounted.
  useStore.getState().bumpAuthGeneration()
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
  if (!restoreInFlight) {
    const run: Promise<void> = runRestore().finally(() => {
      // Only clear the slot if it still points at this run — see
      // documents.ts' initDocuments() for why a stale run's own completion
      // must not clobber a fresher run's slot.
      if (restoreInFlight === run) restoreInFlight = null
    })
    restoreInFlight = run
  }
  return restoreInFlight
}

async function runRestore(): Promise<void> {
  // Same hazard login() guards against: a logout() (or another login())
  // landing while getMe() is in flight means the token this restore is
  // about to commit may no longer be the session's token at all.
  const startedAt = generation
  const token = useStore.getState().token
  if (!token) {
    useStore.getState().setAuth(null, null)
    return
  }
  try {
    const user = await getMe()
    if (startedAt !== generation) return
    useStore.getState().setAuth(token, user)
  } catch (error) {
    // Not the live path for a 401 as of Task 4: getMe()'s own request()
    // call already routed that 401 through handleUnauthorized() ->
    // expireSession() before rejecting, which bumped `generation` — so
    // `startedAt !== generation` is normally true here and this whole catch
    // body returns on the line above without re-running expireSession().
    // The branch below is a correct fallback, not dead code: it is what
    // actually fires 401 handling when client.ts's request() isn't the one
    // producing the error — e.g. session.test.ts, which mocks getMe()
    // directly and so bypasses request() and its handler entirely.
    if (startedAt !== generation) return
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

// Registers expireSession as the handler request()'s 401 branch calls
// (client.ts:handleUnauthorized), scoped there to the token that produced
// the 401. client.ts must not import session.ts back — see its own
// setUnauthorizedHandler comment.
setUnauthorizedHandler(expireSession)

// Bumped by every refreshUser() call. Two LLM completions can each trigger
// their own refresh; the generation/token guards below only catch a session
// change, not two in-flight refreshes racing each other — an older response
// landing last would otherwise regress used_today back down. This counter's
// last-issued value is the only one allowed to commit, so whichever refresh
// started most recently wins regardless of completion order.
let refreshSeq = 0

/**
 * Best-effort /me re-fetch so quota display tracks reality after an LLM
 * run. Generation- and token-guarded exactly like runRestore(): a session
 * change mid-flight must drop the response, and any failure leaves the
 * last-known user in place (freshness is cosmetic; the backend enforces).
 */
export async function refreshUser(): Promise<void> {
  const startedAt = generation
  const token = useStore.getState().token
  if (!token) return
  const seq = ++refreshSeq
  try {
    const user = await getMe()
    if (startedAt !== generation) return
    if (useStore.getState().token !== token) return
    if (seq !== refreshSeq) return
    useStore.getState().setAuth(token, user)
  } catch {
    // Cosmetic refresh only — never surface, never clear state (a real 401
    // already went through handleUnauthorized inside request()).
  }
}

setRefreshUserHandler(refreshUser)
