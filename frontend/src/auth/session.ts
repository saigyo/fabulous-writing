import { getMe, HttpError, postLogin, postLogout, postRefresh, setUnauthorizedHandler } from '../api/client'
import { cancelInFlightCheck } from '../checking/cancelSlot'
import { clearLegacyText, invalidateDocumentWork } from '../documents/documents'
import { clearSnapshot, readSnapshot } from '../documents/buffer'
import { loadUserPrefs } from '../state/prefsPersistence'
import {
  clearRefreshToken,
  clearToken,
  clearTokenExpiresAt,
  clearTokenOwner,
  readRefreshToken,
  readTokenOwner,
  writeRefreshToken,
  writeToken,
  writeTokenExpiresAt,
  writeTokenOwner,
} from '../state/prefsStorage'
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
  const { token, refresh_token, expires_at, user } = await postLogin(email, password)
  // Someone logged out while this was in flight — drop the token on the floor
  // rather than signing a deliberately logged-out user back in.
  if (startedAt !== generation) return false
  generation++
  // A *user change* purges in-memory state and swaps preference
  // namespaces; a same-user re-login (the silent re-auth after a
  // password change, auth/AccountMenu.tsx) must not touch the user's
  // live preferences at all.
  if (previousUserId !== user.id) {
    // Ordering invariant (B1, #34): bulk pref resets/loads happen only
    // while the store's user is null, so the write subscriber
    // (prefsPersistence.ts) cannot commit them to any namespace. In
    // practice user is already null here — the login form only renders
    // while anonymous — but the explicit setAuth keeps the invariant
    // caller-proof.
    useStore.getState().setAuth(null, null)
    resetSessionState()
    loadUserPrefs(user.id)
  }
  discardForeignBuffer(user.id)   // keeps this user's own unsaved work
  // Local mode returns refresh_token/expires_at as null (backend/app/api/
  // auth.py) — writing null clears any stale value from a previous
  // Supabase-mode session under the same browser profile.
  writeToken(token)
  writeRefreshToken(refresh_token ?? null)
  writeTokenExpiresAt(expires_at ?? null)
  writeTokenOwner(String(user.id))
  useStore.setState({ sessionExpired: false, restoreFailed: false })
  useStore.getState().setAuth(token, user)
  useStore.getState().setSessionTokens(token, refresh_token ?? null, expires_at ?? null)
  // Reactive counterpart to the generation++ above (see authGeneration's own
  // comment in state/store.ts): a same-user re-login stays on this same
  // branch — resetSessionState() above is skipped for it — so this bump is
  // the ONLY signal mount effects depending on it see when the
  // password-change flow (auth/AccountMenu.tsx) silently re-authenticates
  // the current user while they stay mounted.
  useStore.getState().bumpAuthGeneration()
  scheduleRefresh()
  return true
}

/** Deliberate exit. The session dies — token and all in-memory state —
 * but the user's preference blob survives by design (B1, #34): it holds
 * no document content and no credentials, and is restored on their next
 * login. */
export function logout(): void {
  generation++
  invalidateDocumentWork()   // first: pending saves must not write the buffer back
  cancelInFlightCheck()
  // Fire before clearToken(): postLogout() reads the store's token at fetch
  // time (client.ts's requestWithOptions), so it must still be there. A
  // visitor who was never signed in (no token) has no server-side session
  // to end. Best-effort: the local teardown below proceeds regardless of
  // whether the request lands.
  const hadToken = !!useStore.getState().token
  if (hadToken) void postLogout().catch(() => {})
  clearToken()
  // Ordering invariant (B1, #34): null the user BEFORE
  // resetSessionState(), or the write subscriber would commit the reset
  // defaults into the departing user's namespace — destroying the
  // preferences that must survive this logout.
  useStore.getState().setAuth(null, null)
  resetSessionState()
  clearSnapshot()
  clearLegacyText()
  clearRefreshToken()
  clearTokenExpiresAt()
  clearTokenOwner()
  // setAuth(null, null) above sets token/user/authStatus/restoreFailed only
  // -- resetSessionState()'s INITIAL_DATA deliberately omits refreshToken/
  // tokenExpiresAt (see its own comment), so without this line they would
  // survive the teardown in the STORE even though storage is cleared, live
  // enough for an already-orphaned refresh timer (see finding 3's fix) to
  // rematerialise a full session for the departed user in localStorage.
  useStore.setState({ refreshToken: null, tokenExpiresAt: null })
  cancelScheduledRefresh()
}

/** The token stopped working. The same user is almost certainly coming
 *  back, so the document buffer is deliberately left alone — it is the
 *  only copy of their unsaved text. Their preference blob survives too
 *  (B1, #34). */
export function expireSession(): void {
  generation++
  invalidateDocumentWork()   // the buffer survives; the work that rewrites it must not
  cancelInFlightCheck()
  clearToken()
  // Same ordering invariant as logout(): user null before the reset.
  useStore.getState().setAuth(null, null)
  resetSessionState()
  useStore.setState({ sessionExpired: true })
  clearRefreshToken()
  clearTokenExpiresAt()
  clearTokenOwner()
  // See logout()'s identical line: the store fields survive setAuth()/
  // resetSessionState() otherwise.
  useStore.setState({ refreshToken: null, tokenExpiresAt: null })
  cancelScheduledRefresh()
}

const REFRESH_MARGIN_MS = 120_000
const REFRESH_RETRY_MS = 60_000
// A floor under the timer-armed refresh delay only. Without it, a rotated
// expiry that already falls inside REFRESH_MARGIN_MS (e.g. a short-TTL
// deployment, ~60s tokens) computes a delay at or near 0 -- the timer fires
// almost immediately, refreshes again, and the same near-zero delay repeats:
// a tight rotation loop. This does not apply to the restore-time refresh
// (runRestore calls refreshSession()/doRefresh() directly, never through
// this delay computation), which is meant to run immediately.
const MIN_REFRESH_DELAY_MS = 30_000
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<boolean> | null = null

function cancelScheduledRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = null
}

// The one and only arming site: every caller (including the retry branch in
// doRefresh's catch below) goes through here, so cancelScheduledRefresh()
// always has the single live handle -- an arm that bypassed this function
// would orphan whatever timer was already running, uncancellable by
// logout()/expireSession() (finding 3, final review).
function scheduleRefresh(delayMs?: number): void {
  cancelScheduledRefresh()
  if (delayMs !== undefined) {
    refreshTimer = setTimeout(() => { void refreshSession() }, delayMs)
    return
  }
  const { tokenExpiresAt, refreshToken } = useStore.getState()
  if (!refreshToken || tokenExpiresAt === null) return  // local mode: never
  const delay = Math.max(
    tokenExpiresAt * 1000 - Date.now() - REFRESH_MARGIN_MS,
    MIN_REFRESH_DELAY_MS,
  )
  refreshTimer = setTimeout(() => { void refreshSession() }, delay)
}

// Generation the current refreshInFlight promise was started under. Without
// this, a promise from a superseded session (e.g. postRefresh hanging past a
// logout+re-login) gets handed to the new generation's caller too: it
// resolves via doRefresh's own `startedAt !== generation` guard into a no-op
// that never re-arms a timer, silently leaving the new session with none
// (finding 4, final review).
let refreshInFlightGen = -1

/** Single-flight per generation, generation-guarded (same discipline as
 * runRestore). On a 401 the refresh token is dead — the session ends
 * through the same expireSession() path as any other credential failure.
 * Any other failure (offline laptop waking up) retries on a fixed cadence;
 * a request-level 401 in the meantime ends the session anyway.
 *
 * Resolves `true` when the token is rotated (or no refresh was needed —
 * e.g. superseded by a generation change, or local mode with no refresh
 * token at all) and `false` on a retryable failure, so a caller like
 * runRestore can tell "the session is fine, proceed" apart from "this
 * attempt failed, don't proceed as if it succeeded" (Copilot round 3). The
 * 401 branch still ends the session through expireSession() exactly as
 * before; its own return value is moot for every current caller, since
 * expireSession() bumps `generation` and every caller re-checks that first.
 */
export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight || refreshInFlightGen !== generation) {
    refreshInFlightGen = generation
    const run = doRefresh().finally(() => {
      if (refreshInFlight === run) refreshInFlight = null
    })
    refreshInFlight = run
  }
  return refreshInFlight
}

async function doRefresh(): Promise<boolean> {
  const startedAt = generation
  const { token: currentToken, refreshToken, tokenExpiresAt, user } = useStore.getState()
  if (!refreshToken) return true
  // Multi-tab mitigation (minimal — NOT full cross-tab coordination): each
  // tab holds its own in-memory copy of the rotating refresh token, and a
  // browser-throttled background tab can wake up and submit a token another
  // tab already rotated past. Re-reading storage right before the call lets
  // this tab adopt whatever the freshest tab already persisted instead of
  // resubmitting a token GoTrue may now treat as reused. The residual: true
  // cross-tab coordination (e.g. electing one tab to own refreshing) is
  // deferred; two tabs refreshing at nearly the same instant, before either
  // has persisted its rotation, are covered by GoTrue's own reuse-detection
  // interval, not by this.
  //
  // localStorage is shared across every tab in the profile, not just tabs
  // on the same account: another tab logging in as a different user leaves
  // THIS tab's in-memory user unchanged but overwrites the shared refresh
  // token with the other account's (Copilot round 4). Adopting it blindly
  // would run this tab's subsequent requests as that other user under its
  // original user's UI state. `user` is null only during the pre-getMe()
  // leg of a fresh page load (store-init/restoreSession) — not a switch,
  // just this tab not having committed to an identity yet — so the owner
  // check is skipped then and existing initialization behavior is
  // unchanged. Once a user IS established, adoption requires the persisted
  // token's owner to match it; a mismatch keeps this tab's own (now stale)
  // token, whose eventual 401 correctly routes through expireSession().
  const stored = readRefreshToken()
  const storedOwner = readTokenOwner()
  const ownerMismatch = user !== null && storedOwner !== String(user.id)
  const refreshTokenToUse =
    stored !== null && stored !== refreshToken && !ownerMismatch ? stored : refreshToken
  if (refreshTokenToUse !== refreshToken && currentToken) {
    useStore.getState().setSessionTokens(currentToken, refreshTokenToUse, tokenExpiresAt)
  }
  try {
    const response = await postRefresh(refreshTokenToUse)
    if (startedAt !== generation) return true
    // Second line of defence behind the owner-key check above: the token
    // and owner-key localStorage writes at the end of THIS function are two
    // separate operations, so a cross-tab race can still land another tab's
    // rotated token here between them, past the ownerMismatch guard, before
    // its own owner key catches up. The response body names its own user
    // authoritatively; a mismatch against this tab's current user means the
    // token just received does not belong to this session, so nothing is
    // committed and the tab's now-untrustworthy session context ends
    // outright instead (closes the separate-writes race, Copilot round 6).
    const storeUser = useStore.getState().user
    if (storeUser !== null && response.user.id !== storeUser.id) {
      expireSession()
      return false
    }
    const { token, refresh_token, expires_at } = response
    writeToken(token)
    writeRefreshToken(refresh_token ?? null)
    writeTokenExpiresAt(expires_at ?? null)
    // Keep the owner key in lockstep with the triple it now names: leaving
    // it pointing at whatever account last wrote it (Copilot round 5) is
    // the same inconsistent-pair hazard the ownerMismatch check above
    // guards against, just created here instead of read there. `user` is
    // re-read fresh (not the pre-await destructure) since this runs after
    // the network round trip; if it's null this is the pre-getMe() restore
    // leg (see the ownerMismatch comment above) where the storage owner
    // key already belongs to this same profile's own prior login, so it's
    // left untouched rather than written with no user to attribute it to.
    const currentUser = useStore.getState().user
    if (currentUser) writeTokenOwner(String(currentUser.id))
    useStore.getState().setSessionTokens(token, refresh_token ?? null, expires_at ?? null)
    scheduleRefresh()
    return true
  } catch (error) {
    if (startedAt !== generation) return true
    if (error instanceof HttpError && error.status === 401) {
      expireSession()
      return false
    }
    // Also the landing spot for postRefresh's AbortSignal.timeout() firing
    // (client.ts): a timed-out fetch rejects with a DOMException/TypeError,
    // never an HttpError, so it falls straight through to this same retry
    // branch as any other network failure — a hung refresh request no
    // longer pins refreshInFlight forever (see REFRESH_TIMEOUT_MS's comment).
    scheduleRefresh(REFRESH_RETRY_MS)
    return false
  }
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
  const { refreshToken, tokenExpiresAt } = useStore.getState()
  // A token due to expire within the margin is refreshed before getMe()
  // ever fires, so the restore lands with a token that survives past this
  // page load rather than expiring moments after it succeeds.
  if (
    tokenExpiresAt !== null &&
    refreshToken &&
    tokenExpiresAt * 1000 - Date.now() < REFRESH_MARGIN_MS
  ) {
    const refreshed = await refreshSession()
    if (startedAt !== generation) return
    if (!refreshed) {
      // The pre-restore refresh failed transiently (network/5xx) rather
      // than with a 401 -- a 401 already ended the session via
      // expireSession() and returned above through the generation guard.
      // Calling getMe() now would 401 on the still-expired token and clear
      // an otherwise still-usable refresh token (Copilot round 3).
      // doRefresh()'s own catch already armed a retry timer
      // (scheduleRefresh(REFRESH_RETRY_MS)), so leave the token pair alone
      // and let that retry -- or a later restoreSession() call -- resume
      // normally; restoreInFlight below still clears via its .finally(),
      // so this run does not block a subsequent one.
      useStore.setState({ restoreFailed: true })   // authStatus stays 'unknown'
      return
    }
  }
  // Captured AFTER the refresh above: a stale-expiry restore may have
  // rotated the token, and both the generation guard below and the
  // eventual setAuth() must commit the rotated token, not the one this
  // restore started with.
  const token = useStore.getState().token
  if (!token) {
    useStore.getState().setAuth(null, null)
    return
  }
  try {
    const user = await getMe()
    if (startedAt !== generation) return
    // Ordering invariant (B1, #34): load the restored user's preferences
    // before setAuth makes them visible — while user is still null the
    // write subscriber stays silent, and once setAuth lands the loaded
    // values are already in place, so no write fires.
    loadUserPrefs(user.id)
    useStore.getState().setAuth(token, user)
    scheduleRefresh()
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
// landing last would otherwise regress the usage windows back down. This counter's
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
