import { useEffect, useState } from 'react'
import {
  ADMIN_MIN_PASSWORD_LENGTH,
  getAdminTiers,
  getAdminUsers,
  postAdminUser,
  type AdminUser,
} from '../api/client'
import { sessionGeneration } from '../auth/session'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'

export function AdminView() {
  const me = useStore((s) => s.user)
  const m = useMessages()
  const [users, setUsers] = useState<AdminUser[]>([])
  // null = not loaded (or failed). Tier names are config-defined and never
  // guessed client-side: a hardcoded fallback would offer options a
  // custom-tier deployment rejects with 422, so creation stays disabled
  // until this loads.
  const [tiers, setTiers] = useState<string[] | null>(null)
  const { error, run, fail } = useCrudError(m.adminChangeFailed)

  // Mounted only while the view is active and the user is an admin
  // (App.tsx render guard), so these are the only /api/admin requests the
  // session ever issues — spec §8's no-403-noise rule is structural.
  useEffect(() => {
    const gen = sessionGeneration()
    getAdminUsers()
      .then((list) => { if (sessionGeneration() === gen) setUsers(list) })
      .catch(() => { if (sessionGeneration() === gen) fail(m.adminLoadFailed) })
    getAdminTiers()
      .then((list) => { if (sessionGeneration() === gen) setTiers(list) })
      .catch(() => { if (sessionGeneration() === gen) fail(m.adminLoadFailed) })
    // Mount-once by design: the view remounts per activation, which is
    // exactly the refetch cadence the spec wants. `fail` and
    // `m.adminLoadFailed` are deliberately excluded from the deps below so
    // this never re-fires on a locale change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const allowMoreAdmins = me?.allow_additional_admins ?? false

  return (
    <div className="admin-view">
      <h2>{m.adminUsersTitle}</h2>
      {error && <p className="admin-error" role="alert">{error}</p>}
      <CreateForm
        tiers={tiers}
        allowMoreAdmins={allowMoreAdmins}
        onCreated={(user) => setUsers((current) => [...current, user])}
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
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                {user.email}
                {user.id === me?.id && <span className="admin-self"> {m.adminSelf}</span>}
              </td>
              <td>{user.display_name ?? ''}</td>
              <td>{user.tier}</td>
              <td>{user.is_admin ? '✓' : ''}</td>
              <td>{user.is_active ? '✓' : ''}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface CreateFormProps {
  tiers: string[] | null
  allowMoreAdmins: boolean
  onCreated: (user: AdminUser) => void
  run: (action: () => Promise<void>) => Promise<void>
  fail: (message: string) => void
}

function CreateForm({ tiers, allowMoreAdmins, onCreated, run, fail }: CreateFormProps) {
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
    if (!tiers || pending || !email.trim() || !password) return
    if (password.length < ADMIN_MIN_PASSWORD_LENGTH) {
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
          password,
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
        disabled={!tiers || pending || !email.trim() || !password}
      >
        {m.adminCreate}
      </button>
    </div>
  )
}
