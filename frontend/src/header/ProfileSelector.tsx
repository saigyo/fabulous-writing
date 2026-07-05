import { updateProfile } from '../api/client'
import { useMessages } from '../i18n'
import { isProfileDirty } from '../profiles/profile'
import { useStore } from '../state/store'

export function ProfileSelector() {
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const selectProfile = useStore((s) => s.selectProfile)
  const domainIds = useStore((s) => s.domainIds)
  const provider = useStore((s) => s.provider)
  const model = useStore((s) => s.model)
  const m = useMessages()

  const selected = profiles.find((p) => p.id === profileId) ?? null
  const dirty =
    selected !== null && isProfileDirty(selected, { domainIds, provider, model })

  async function saveOverrides() {
    if (!selected) return
    const saved = await updateProfile(selected.id, {
      name: selected.name,
      categories_off: selected.categories_off,
      rule_exceptions: selected.rule_exceptions,
      domain_ids: domainIds,
      llm_provider: provider,
      llm_model: model,
      llm_instructions: selected.llm_instructions,
      example_text: selected.example_text,
    })
    useStore.getState().setProfiles(
      profiles.map((p) => (p.id === saved.id ? saved : p)),
    )
  }

  return (
    <label className="profile-select" title={dirty ? m.profileModifiedTitle : undefined}>
      {m.profile}
      <select
        value={profileId ?? ''}
        onChange={(e) => {
          const next = profiles.find((p) => p.id === Number(e.target.value))
          if (next) selectProfile(next, true)
        }}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.id === profileId && dirty ? ' ✱' : ''}
          </option>
        ))}
      </select>
      {dirty && (
        <span className="profile-dirty-actions">
          <button
            className="icon-button"
            title={m.saveToProfile}
            onClick={() => void saveOverrides()}
          >
            💾
          </button>
          <button
            className="icon-button"
            title={m.resetToProfile}
            onClick={() => selected && selectProfile(selected, true)}
          >
            ↩
          </button>
        </span>
      )}
    </label>
  )
}
