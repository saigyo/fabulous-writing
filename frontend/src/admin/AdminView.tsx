import { useEffect, useState } from 'react'
import {
  ADMIN_MIN_PASSWORD_LENGTH,
  getAdminTiers,
  getAdminUsers,
  patchAdminUser,
  postAdminUser,
  type AdminUser,
  type AdminUserPatch,
} from '../api/client'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'

export function AdminView() {
  const me = useStore((s) => s.user)
  const authFeatures = useStore((s) => s.authFeatures)
  const m = useMessages()
  // null = not loaded (or failed), for both. Tier names are config-defined
  // and never guessed client-side: a hardcoded fallback would offer options
  // a custom-tier deployment rejects with 422. The user list is required
  // too — creation must wait for it to settle, or a stale setUsers(list)
  // landing after a create can drop the new row or duplicate it.
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [tiers, setTiers] = useState<string[] | null>(null)
  const { error, run, fail } = useCrudError(m.adminChangeFailed)

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

  // Returns whether the change actually committed: run() swallows the
  // rejection into the error banner, so callers that must react to the
  // outcome (password reset clearing its field) need this signal.
  async function save(user: AdminUser, patch: AdminUserPatch): Promise<boolean> {
    const gen = sessionGeneration()
    let committed = false
    await run(async () => {
      const updated = await patchAdminUser(user.id, patch)
      if (sessionGeneration() !== gen) return // session ended: do not write
      setUsers((current) => current?.map((u) => (u.id === updated.id ? updated : u)) ?? current)
      committed = true
    })
    return committed
  }

  return (
    <div className="admin-view">
      <h2>{m.adminUsersTitle}</h2>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <CreateForm
        tiers={tiers}
        usersLoaded={users !== null}
        allowMoreAdmins={allowMoreAdmins}
        invitesAvailable={authFeatures?.invites ?? false}
        onCreated={(user) => setUsers((current) => [...(current ?? []), user])}
        run={run}
        fail={fail}
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
              onSave={save}
              fail={fail}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface CreateFormProps {
  tiers: string[] | null
  usersLoaded: boolean
  allowMoreAdmins: boolean
  // authFeatures.invites (Task 7): when true, the password field becomes
  // optional — an empty submission sends { password: undefined } and the
  // backend invites the new user through Supabase instead of setting a
  // credential directly.
  invitesAvailable: boolean
  onCreated: (user: AdminUser) => void
  run: (action: () => Promise<void>) => Promise<void>
  fail: (message: string) => void
}

function CreateForm({
  tiers,
  usersLoaded,
  allowMoreAdmins,
  invitesAvailable,
  onCreated,
  run,
  fail,
}: CreateFormProps) {
  const m = useMessages()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [tier, setTier] = useState('basic')
  const [isAdmin, setIsAdmin] = useState(false)
  // Double-click guard: the second submit of the same form would create the
  // user twice or turn a success into a misleading duplicate-email banner.
  const [pending, setPending] = useState(false)

  // Config-defined tiers arrive async and need not contain 'basic' — snap
  // the selection to a real option once the catalog lands (spec §6.1: tier
  // names are whatever the config says).
  useEffect(() => {
    if (tiers && tiers.length > 0 && !tiers.includes(tier)) setTier(tiers[0])
  }, [tiers, tier])

  async function create() {
    // Without invites, an empty password still fails this guard exactly as
    // before — invitesAvailable is false and the byte-identical behaviour
    // the brief requires falls straight out of that.
    if (!tiers || !usersLoaded || pending || !email.trim() || (!password && !invitesAvailable)) {
      return
    }
    // A non-empty short password still fails this check regardless of
    // invites — only an empty field (the invited-user path) skips it.
    if (password && password.length < ADMIN_MIN_PASSWORD_LENGTH) {
      // Reuses the existing parameterized key (AccountMenu precedent) —
      // no second hardcoded-floor message to drift.
      fail(m.passwordTooShort(ADMIN_MIN_PASSWORD_LENGTH))
      return
    }
    const gen = sessionGeneration()
    setPending(true)
    try {
      await run(async () => {
        const created = await postAdminUser({
          email: email.trim(),
          password: password || undefined,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          tier,
          is_admin: isAdmin,
        })
        if (sessionGeneration() !== gen) return // session ended: do not write
        setEmail('')
        setDisplayName('')
        setPassword('')
        setIsAdmin(false)
        onCreated(created)
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="admin-create">
      <input
        type="email"
        value={email}
        placeholder={m.adminEmail}
        aria-label={m.adminEmail}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        value={displayName}
        placeholder={m.adminDisplayName}
        aria-label={m.adminDisplayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <input
        type="password"
        value={password}
        placeholder={m.adminPassword}
        aria-label={m.adminPassword}
        title={invitesAvailable ? m.adminPasswordOptionalHint : undefined}
        onChange={(e) => setPassword(e.target.value)}
      />
      <select
        value={tier}
        disabled={!tiers}
        aria-label={m.adminTier}
        onChange={(e) => setTier(e.target.value)}
      >
        {(tiers ?? []).map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
      <label title={allowMoreAdmins ? undefined : m.adminGrantDisabledHint}>
        <input
          type="checkbox"
          checked={isAdmin}
          disabled={!allowMoreAdmins}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
        {m.adminIsAdmin}
      </label>
      <button
        onClick={() => void create()}
        disabled={
          !tiers || !usersLoaded || pending || !email.trim() || (!password && !invitesAvailable)
        }
      >
        {m.adminCreate}
      </button>
    </div>
  )
}

interface UserRowProps {
  user: AdminUser
  isSelf: boolean
  tiers: string[]
  allowMoreAdmins: boolean
  onSave: (user: AdminUser, patch: AdminUserPatch) => Promise<boolean>
  fail: (message: string) => void
}

function UserRow({ user, isSelf, tiers, allowMoreAdmins, onSave, fail }: UserRowProps) {
  const m = useMessages()
  // null = not editing: the input shows the server value until the admin
  // types, so an external display_name change resyncs without remounting
  // the row (which would wipe the reset-password field below).
  const [draftName, setDraftName] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  // Double-click guard for the reset button: a second in-flight PATCH would
  // revoke tokens and write audit rows twice.
  const [resetPending, setResetPending] = useState(false)

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
      // Clear only on a committed reset: run() swallows failures into the
      // error banner, so a failed PATCH must leave the typed password in
      // place rather than wiping it under the error message.
      if (await onSave(user, { password: newPassword })) setNewPassword('')
    } finally {
      setResetPending(false)
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
          </>
        )}
      </td>
    </tr>
  )
}
