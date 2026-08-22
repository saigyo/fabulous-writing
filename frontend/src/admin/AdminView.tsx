import { useEffect, useState } from 'react'
import {
  ADMIN_MIN_PASSWORD_LENGTH,
  getAdminTiers,
  getAdminUsers,
  HttpError,
  patchAdminUser,
  postAdminUser,
  postResendInvite,
  type AdminUser,
  type AdminUserPatch,
} from '../api/client'
import { sessionGeneration } from '../auth/session'
import { mapWeakPasswordReasons } from '../auth/weakPassword'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages, type Messages } from '../i18n'
import { useStore } from '../state/store'

// Same shape as AccountMenu's mapChangeError: a password_weak rejection gets
// the honest reasons-based message; everything else (duplicate email, 500s,
// ...) falls back to the existing generic formatter.
function mapAdminError(err: unknown, m: Messages): string {
  if (err instanceof HttpError && err.code === 'password_weak') {
    return mapWeakPasswordReasons(err.reasons, m)
  }
  if (err instanceof HttpError && err.code === 'user_inactive') {
    return m.adminUserInactive
  }
  return m.adminChangeFailed(err instanceof Error ? err.message : String(err))
}

// The create-row inputs live inside a <tr> (table content model forbids a
// <form> there — it cannot wrap or sit inside thead/tbody), so association
// runs the other way: an empty <form> sits beside the <table> and every
// input/select/button points at it via the `form` attribute. That keeps a
// single native submission path — the form's onSubmit — reachable from
// both a button click and an Enter key press in any text field, exactly
// like a normal wrapped form.
const CREATE_FORM_ID = 'admin-create-form'

export function AdminView() {
  const me = useStore((s) => s.user)
  const authFeatures = useStore((s) => s.authFeatures)
  const setActivitySubject = useStore((s) => s.setActivitySubject)
  const setActiveView = useStore((s) => s.setActiveView)
  const m = useMessages()
  // null = not loaded (or failed), for both. Tier names are config-defined
  // and never guessed client-side: a hardcoded fallback would offer options
  // a custom-tier deployment rejects with 422. The user list is required
  // too — creation must wait for it to settle, or a stale setUsers(list)
  // landing after a create can drop the new row or duplicate it.
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [tiers, setTiers] = useState<string[] | null>(null)
  const { error, fail, clear } = useCrudError(m.adminChangeFailed)
  // No prior success-banner channel existed (Task 7 adds it): a resend or an
  // invite-linking create has something worth telling the admin even though
  // nothing failed. role="status" (polite), unlike admin-error's role="alert".
  const [notice, setNotice] = useState<string | null>(null)

  // Mounted only while the view is active and the user is an admin
  // (App.tsx render guard), so these are the only /api/admin requests the
  // session ever issues — spec §8's no-403-noise rule is structural.
  // Mount-once by design: the view remounts per activation, which is
  // exactly the refetch cadence the spec wants.
  useEffect(() => {
    const gen = sessionGeneration()
    getAdminUsers()
      .then((list) => { if (sessionGeneration() === gen) setUsers(list) })
      .catch(() => { if (sessionGeneration() === gen) fail(m.adminLoadFailed) })
    getAdminTiers()
      .then((list) => { if (sessionGeneration() === gen) setTiers(list) })
      .catch(() => { if (sessionGeneration() === gen) fail(m.adminLoadFailed) })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once: `fail`/`m.adminLoadFailed` must not re-fire this on a locale change
  }, [])

  const allowMoreAdmins = me?.allow_additional_admins ?? false
  // authFeatures.invites (Task 7): when true, the password field becomes
  // optional — an empty submission sends { password: undefined } and the
  // backend invites the new user through Supabase instead of setting a
  // credential directly.
  const invitesAvailable = authFeatures?.invites ?? false
  const usersLoaded = users !== null

  // Returns whether the change actually committed: a rejection is swallowed
  // into the error banner here, so callers that must react to the outcome
  // (password reset clearing its field) need this signal.
  async function save(user: AdminUser, patch: AdminUserPatch): Promise<boolean> {
    const gen = sessionGeneration()
    let committed = false
    setNotice(null)
    clear()
    try {
      const updated = await patchAdminUser(user.id, patch)
      if (sessionGeneration() === gen) {
        setUsers((current) => current?.map((u) => (u.id === updated.id ? updated : u)) ?? current)
        committed = true
      } // else: session ended, do not write
    } catch (err) {
      // Weak-password reasons (a password reset, PATCH-with-password) need
      // the same honest mapping AccountMenu's mapChangeError applies —
      // wired via mapAdminError rather than useCrudError's format(), which
      // only ever sees a stringified message, not the HttpError itself.
      fail(mapAdminError(err, m))
    }
    return committed
  }

  // Owned by the parent (Task 7): resend is not tied to a row's own PATCH
  // lifecycle, and 204/already_active map onto the shared notice/error
  // channels the same way every other mutation here does.
  async function resendInvite(user: AdminUser): Promise<void> {
    const gen = sessionGeneration()
    setNotice(null)
    clear()
    try {
      await postResendInvite(user.id)
      if (sessionGeneration() !== gen) return // session ended: do not surface
      setNotice(m.adminResendSent)
    } catch (err) {
      if (sessionGeneration() !== gen) return
      if (err instanceof HttpError && err.code === 'already_active') {
        fail(m.adminResendAlreadyActive)
      } else {
        fail(mapAdminError(err, m))
      }
    }
  }

  // ---- create-user row state ----
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [tier, setTier] = useState('basic')
  const [isAdmin, setIsAdmin] = useState(false)
  // Double-click guard: a second submit of the same form would create the
  // user twice or turn a success into a misleading duplicate-email banner.
  const [pending, setPending] = useState(false)

  // Config-defined tiers arrive async and need not contain 'basic' — snap
  // the selection to a real option once the catalog lands (spec §6.1: tier
  // names are whatever the config says).
  useEffect(() => {
    if (tiers && tiers.length > 0 && !tiers.includes(tier)) setTier(tiers[0])
  }, [tiers, tier])

  const createDisabled =
    !tiers || !usersLoaded || pending || !email.trim() || (!password && !invitesAvailable)

  async function createUser() {
    // Without invites, an empty password still fails this guard exactly as
    // before — invitesAvailable is false and the byte-identical behaviour
    // the brief requires falls straight out of that.
    if (createDisabled) return
    // A non-empty short password still fails this check regardless of
    // invites — only an empty field (the invited-user path) skips it.
    if (password && password.length < ADMIN_MIN_PASSWORD_LENGTH) {
      // Reuses the existing parameterized key (AccountMenu precedent) —
      // no second hardcoded-floor message to drift.
      setNotice(null)
      fail(m.passwordTooShort(ADMIN_MIN_PASSWORD_LENGTH))
      return
    }
    const gen = sessionGeneration()
    setPending(true)
    setNotice(null)
    clear()
    try {
      const created = await postAdminUser({
        email: email.trim(),
        password: password || undefined,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        tier,
        is_admin: isAdmin,
      })
      if (sessionGeneration() === gen) {
        setEmail('')
        setDisplayName('')
        setPassword('')
        setIsAdmin(false)
        setUsers((current) => [...(current ?? []), created])
        // Plain create (no invite) shows nothing — unchanged. An invite that
        // actually sent mail says so; one that only linked an existing
        // pending invite must not claim a new email went out.
        if (created.invited && created.invite_emailed) setNotice(m.adminInviteSent)
        else if (created.invited && !created.invite_emailed) setNotice(m.adminInviteLinkedNoEmail)
      } // else: session ended, do not write
    } catch (err) {
      fail(mapAdminError(err, m))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="admin-view">
      <h2>{m.adminUsersTitle}</h2>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      <button
        type="button"
        className="admin-activity-link"
        onClick={() => {
          setActivitySubject('all')
          setActiveView('activity')
        }}
      >
        {m.adminAllActivity}
      </button>
      <form
        id={CREATE_FORM_ID}
        onSubmit={(e) => {
          e.preventDefault()
          void createUser()
        }}
      />
      <table className="admin-users">
        <thead>
          <tr>
            <th>{m.adminEmail}</th>
            <th>{m.adminDisplayName}</th>
            <th>{m.adminTier}</th>
            <th>{m.adminIsAdmin}</th>
            <th>{m.adminIsActive}</th>
            <th>{m.adminResetPassword}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="admin-create-row">
            <td>
              <input
                type="email"
                form={CREATE_FORM_ID}
                value={email}
                placeholder={m.adminEmail}
                aria-label={m.adminEmail}
                onChange={(e) => setEmail(e.target.value)}
              />
            </td>
            <td>
              <input
                form={CREATE_FORM_ID}
                value={displayName}
                placeholder={m.adminDisplayName}
                aria-label={m.adminDisplayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </td>
            <td>
              <select
                form={CREATE_FORM_ID}
                value={tier}
                disabled={!tiers}
                aria-label={m.adminTier}
                onChange={(e) => setTier(e.target.value)}
              >
                {(tiers ?? []).map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </td>
            <td>
              <label title={allowMoreAdmins ? undefined : m.adminGrantDisabledHint}>
                <input
                  type="checkbox"
                  form={CREATE_FORM_ID}
                  checked={isAdmin}
                  disabled={!allowMoreAdmins}
                  onChange={(e) => setIsAdmin(e.target.checked)}
                />
                {m.adminIsAdmin}
              </label>
            </td>
            <td>{'—'}</td>
            <td>
              <div className="admin-create-cell">
                <input
                  type="password"
                  form={CREATE_FORM_ID}
                  value={password}
                  placeholder={m.adminPassword}
                  aria-label={m.adminPassword}
                  aria-describedby={invitesAvailable ? 'admin-password-hint' : undefined}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {invitesAvailable && (
                  <p id="admin-password-hint" className="admin-field-hint">
                    {m.adminPasswordOptionalHint}
                  </p>
                )}
                <button type="submit" form={CREATE_FORM_ID} disabled={createDisabled}>
                  {m.adminCreate}
                </button>
              </div>
            </td>
          </tr>
          {(users ?? []).map((user) => (
            <UserRow
              // Key stays user.id: folding display_name in would remount the
              // row after a name save and silently erase a password already
              // typed in its reset field. The name input instead uses a
              // draft-or-prop pattern (see UserRow) so it needs no remount
              // to resync.
              key={user.id}
              user={user}
              isSelf={user.id === me?.id}
              tiers={tiers ?? []}
              allowMoreAdmins={allowMoreAdmins}
              invitesAvailable={invitesAvailable}
              onSave={save}
              onResend={resendInvite}
              fail={fail}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface UserRowProps {
  user: AdminUser
  isSelf: boolean
  tiers: string[]
  allowMoreAdmins: boolean
  invitesAvailable: boolean
  onSave: (user: AdminUser, patch: AdminUserPatch) => Promise<boolean>
  onResend: (user: AdminUser) => Promise<void>
  fail: (message: string) => void
}

function UserRow({
  user,
  isSelf,
  tiers,
  allowMoreAdmins,
  invitesAvailable,
  onSave,
  onResend,
  fail,
}: UserRowProps) {
  const m = useMessages()
  // null = not editing: the input shows the server value until the admin
  // types, so an external display_name change resyncs without remounting
  // the row (which would wipe the reset-password field below).
  const [draftName, setDraftName] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  // Double-click guard for the reset button: a second in-flight PATCH would
  // revoke tokens and write audit rows twice.
  const [resetPending, setResetPending] = useState(false)
  // Same guard for resend: a second in-flight POST would fire a duplicate
  // invitation email.
  const [resendPending, setResendPending] = useState(false)

  // The disabled states mirror server guards the UI cannot replace:
  // self-demotion/self-deactivation 409 (admin.py lockout rule) and
  // promotion 403 while auth.allow_additional_admins is off. Demotion of
  // OTHER admins stays enabled — it only ever reduces privilege.
  const adminToggleDisabled = isSelf || (!user.is_admin && !allowMoreAdmins)

  function saveName() {
    if (draftName === null) return
    const trimmed = draftName.trim()
    setDraftName(null) // back to showing the server value (updated on success)
    if (trimmed === (user.display_name ?? '')) return
    void onSave(user, { display_name: trimmed === '' ? null : trimmed })
  }

  async function resetPassword() {
    if (resetPending) return
    if (newPassword.length < ADMIN_MIN_PASSWORD_LENGTH) {
      fail(m.passwordTooShort(ADMIN_MIN_PASSWORD_LENGTH))
      return
    }
    setResetPending(true)
    try {
      // Clear only on a committed reset: a failed PATCH must leave the
      // typed password in place rather than wiping it under the error
      // message (onSave itself routes failures to the error banner).
      if (await onSave(user, { password: newPassword })) setNewPassword('')
    } finally {
      setResetPending(false)
    }
  }

  async function resendInvite() {
    if (resendPending) return
    setResendPending(true)
    try {
      await onResend(user)
    } finally {
      setResendPending(false)
    }
  }

  return (
    <tr className={user.is_active ? '' : 'admin-inactive'}>
      <td>
        {user.email}
        {isSelf && <span className="admin-self"> {m.adminSelf}</span>}
      </td>
      <td>
        <input
          value={draftName ?? user.display_name ?? ''}
          aria-label={`${m.adminDisplayName}: ${user.email}`}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={saveName}
        />
      </td>
      <td>
        <select
          value={user.tier}
          aria-label={`${m.adminTier}: ${user.email}`}
          onChange={(e) => void onSave(user, { tier: e.target.value })}
        >
          {/* A user can sit on a tier no longer in config — keep it as an
              option or the controlled select silently shows the wrong one. */}
          {(tiers.includes(user.tier) ? tiers : [user.tier, ...tiers]).map((tierName) => (
            <option key={tierName} value={tierName}>{tierName}</option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          checked={user.is_admin}
          disabled={adminToggleDisabled}
          aria-label={`${m.adminIsAdmin}: ${user.email}`}
          title={!isSelf && !user.is_admin && !allowMoreAdmins ? m.adminGrantDisabledHint : undefined}
          onChange={(e) => void onSave(user, { is_admin: e.target.checked })}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={user.is_active}
          disabled={isSelf}
          aria-label={`${m.adminIsActive}: ${user.email}`}
          onChange={(e) => void onSave(user, { is_active: e.target.checked })}
        />
      </td>
      <td className="admin-reset">
        {isSelf ? (
          <span className="admin-self-reset-hint">{m.adminSelfResetHint}</span>
        ) : (
          <>
            <input
              type="password"
              value={newPassword}
              placeholder={m.adminPassword}
              aria-label={`${m.adminResetPassword}: ${user.email}`}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              disabled={!newPassword || resetPending}
              onClick={() => void resetPassword()}
            >
              {m.adminResetPassword}
            </button>
            {invitesAvailable && user.external_id !== null && (
              <button
                className="admin-resend"
                // A deactivated user must not be re-invited: the backend
                // would answer with GoTrue's "already accepted" (absurd
                // beside a row showing the account deactivated), and
                // reactivation is the admin's actual next step (B32/#106
                // adds the server-side guard).
                disabled={resendPending || !user.is_active}
                onClick={() => void resendInvite()}
              >
                {m.adminResendInvite}
              </button>
            )}
          </>
        )}
      </td>
    </tr>
  )
}
