import { updateProfile } from '../api/client'
import { currentGeneration } from '../documents/autosave'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages } from '../i18n'
import { isProfileDirty } from '../profiles/profile'
import { useStore } from '../state/store'

export function ProfileSelector() {
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const selectProfile = useStore((s) => s.selectProfile)
  const domainIds = useStore((s) => s.domainIds)
  const tier = useStore((s) => s.tier)
  const provider = useStore((s) => s.provider)
  const model = useStore((s) => s.model)
  const isAdmin = useStore((s) => s.user?.is_admin ?? false)
  const m = useMessages()
  const { error, run } = useCrudError(m.profileChangeFailed)

  const selected = profiles.find((p) => p.id === profileId) ?? null
  const dirty =
    selected !== null && isProfileDirty(selected, { domainIds, tier, provider, model })
  const readOnly = selected !== null && selected.is_global && !isAdmin

  async function saveOverrides() {
    if (!selected || readOnly) return
    // Captured before the request goes out: a session ending mid-request
    // must not land this write in the incoming session's store. Also reads
    // `profiles` fresh (not the pre-await closure above) after the await, so
    // it can't clobber a `profiles` update that landed while this was in
    // flight, session turnover or not.
    const gen = currentGeneration()
    await run(async () => {
      const saved = await updateProfile(selected.id, {
        name: selected.name,
        categories_off: selected.categories_off,
        rule_exceptions: selected.rule_exceptions,
        packs_on: selected.packs_on,
        domain_ids: domainIds,
        llm_tier: tier,
        llm_provider: tier === null ? provider : null,
        llm_model: tier === null ? model : null,
        llm_instructions: selected.llm_instructions,
        example_text: selected.example_text,
      })
      if (gen !== currentGeneration()) return // session ended: do not write
      const s = useStore.getState()
      s.setProfiles(s.profiles.map((p) => (p.id === saved.id ? saved : p)))
    })
  }

  return (
    <label className="profile-select" title={dirty ? m.profileModifiedTitle : undefined}>
      {m.profile}
      <span className="profile-select-row">
        {error && (
          <span className="profile-select-error" title={error}>
            ⚠
          </span>
        )}
        {dirty && (
          <span className="profile-dirty-actions">
            {!readOnly && (
              <button
                className="icon-button"
                title={m.saveToProfile}
                onClick={() => void saveOverrides()}
              >
                <SaveIcon />
              </button>
            )}
            <button
              className="icon-button"
              title={m.resetToProfile}
              onClick={() => selected && selectProfile(selected, true)}
            >
              <ResetIcon />
            </button>
          </span>
        )}
        <select
          value={profileId ?? ''}
          onChange={(e) => {
            const next = profiles.find((p) => p.id === Number(e.target.value))
            if (next) selectProfile(next, true)
          }}
        >
          {profileId === null && (
            <option value="" disabled>
              —
            </option>
          )}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === profileId && dirty ? ' ✱' : ''}
            </option>
          ))}
        </select>
      </span>
    </label>
  )
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  )
}
