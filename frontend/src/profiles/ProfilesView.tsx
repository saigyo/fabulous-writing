import { useState } from 'react'
import {
  createProfile,
  deleteProfile,
  resetProfile,
  updateProfile,
} from '../api/client'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { TIERS, type Profile, type Tier } from '../types'

export function ProfilesView() {
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const language = useStore((s) => s.language)
  const m = useMessages()
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selected = profiles.find((p) => p.id === profileId) ?? null

  function refresh(next: Profile[], select?: Profile) {
    const store = useStore.getState()
    store.setProfiles(next)
    if (select) store.selectProfile(select, true)
  }

  function reportError(e: unknown) {
    setError(m.profileChangeFailed(e instanceof Error ? e.message : String(e)))
  }

  async function create() {
    if (!newName.trim()) return
    const state = useStore.getState()
    const base = selected
    try {
      const created = await createProfile({
        language,
        name: newName.trim(),
        categories_off: base?.categories_off ?? [],
        rule_exceptions: base?.rule_exceptions ?? [],
        domain_ids: state.domainIds,
        llm_tier: state.tier,
        llm_provider: state.tier === null ? state.provider : null,
        llm_model: state.tier === null ? state.model : null,
        llm_instructions: base?.llm_instructions ?? '',
        example_text: base?.example_text ?? '',
      })
      setNewName('')
      setError(null)
      refresh([...profiles, created], created)
    } catch (e) {
      reportError(e)
    }
  }

  async function save(profile: Profile, patch: Partial<Profile>) {
    const merged = { ...profile, ...patch }
    try {
      const saved = await updateProfile(profile.id, {
        name: merged.name,
        categories_off: merged.categories_off,
        rule_exceptions: merged.rule_exceptions,
        domain_ids: merged.domain_ids,
        llm_tier: merged.llm_tier,
        llm_provider: merged.llm_provider,
        llm_model: merged.llm_model,
        llm_instructions: merged.llm_instructions,
        example_text: merged.example_text,
      })
      setError(null)
      refresh(
        profiles.map((p) => (p.id === saved.id ? saved : p)),
        saved.id === profileId ? saved : undefined,
      )
    } catch (e) {
      reportError(e)
    }
  }

  async function remove(profile: Profile) {
    try {
      await deleteProfile(profile.id)
      const rest = profiles.filter((p) => p.id !== profile.id)
      const fallback = rest.find((p) => p.is_standard) ?? rest[0]
      setError(null)
      refresh(rest, profile.id === profileId ? fallback : undefined)
    } catch (e) {
      reportError(e)
    }
  }

  async function reset(profile: Profile) {
    try {
      const restored = await resetProfile(profile.id)
      setError(null)
      refresh(
        profiles.map((p) => (p.id === restored.id ? restored : p)),
        restored.id === profileId ? restored : undefined,
      )
    } catch (e) {
      reportError(e)
    }
  }

  return (
    <div className="profiles-view">
      <header className="profiles-header">
        <h2>{m.profilesTitle}</h2>
        <div className="profiles-create">
          <input
            placeholder={m.newProfilePlaceholder}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button title={m.createProfileTitle} onClick={() => void create()}>
            {m.add}
          </button>
        </div>
      </header>
      {error && <p className="profiles-error">{error}</p>}
      <div className="profiles-list">
        {profiles.map((profile) => (
          <ProfileCard
            // The card keeps local draft state for text fields (name,
            // instructions, example) so typing doesn't round-trip through
            // the store on every keystroke. Folding the server-owned values
            // into the key forces a remount (and thus a fresh draft) only
            // when they change from outside the card's own onBlur save —
            // e.g. a Reset — while normal typing leaves the key untouched
            // until after the value already matches what was saved.
            key={`${profile.id}:${profile.name}:${profile.llm_instructions}:${profile.example_text}`}
            profile={profile}
            active={profile.id === profileId}
            onSave={(patch) => void save(profile, patch)}
            onDelete={() => void remove(profile)}
            onReset={() => void reset(profile)}
          />
        ))}
      </div>
    </div>
  )
}

function ProfileCard({
  profile,
  active,
  onSave,
  onDelete,
  onReset,
}: {
  profile: Profile
  active: boolean
  onSave: (patch: Partial<Profile>) => void
  onDelete: () => void
  onReset: () => void
}) {
  const m = useMessages()
  const providers = useStore((s) => s.providers)
  const domains = useStore((s) => s.domains)
  const [name, setName] = useState(profile.name)
  const [instructions, setInstructions] = useState(profile.llm_instructions)
  const [example, setExample] = useState(profile.example_text)

  const activeProvider = providers.find((p) => p.name === profile.llm_provider)

  return (
    <section className={`profile-card${active ? ' selected' : ''}`}>
      <div className="profile-card-title">
        <input
          value={name}
          disabled={profile.is_standard}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== profile.name && onSave({ name })}
        />
        {profile.is_standard ? (
          <button className="icon-button" title={m.resetStandardTitle} onClick={onReset}>↺</button>
        ) : (
          <button className="icon-button" title={m.deleteProfileTitle} onClick={onDelete}>✕</button>
        )}
      </div>
      {/* A shared grid: row 1 holds domain (left) and the LLM selectors
          (right), row 2 the two text boxes — so their labels and upper
          boundaries always align across the columns. */}
      <div className="profile-card-columns">
        <label className="profile-card-domain">
          {m.domain}
          <select
            multiple
            value={profile.domain_ids.map(String)}
            onChange={(e) =>
              onSave({
                domain_ids: [...e.target.selectedOptions].map((o) => Number(o.value)),
              })
            }
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <div className="profile-card-llm">
          <span className="field-label">{m.llm}</span>
          <div className="tier-options" role="radiogroup">
            {TIERS.map((tier) => (
              <button
                key={tier}
                className={`tier-option${
                  profile.llm_provider === null && profile.llm_tier === tier
                    ? ' selected'
                    : ''
                }`}
                onClick={() =>
                  onSave({ llm_tier: tier, llm_provider: null, llm_model: null })
                }
              >
                {m.tierName(tier as Tier)}
              </button>
            ))}
          </div>
          {profile.llm_provider !== null && (
            <p className="pinned-note">
              {m.pinnedNote}
              <button
                className="icon-button"
                title={m.clearPin}
                onClick={() => onSave({ llm_provider: null, llm_model: null })}
              >
                ✕
              </button>
            </p>
          )}
          <details className="llm-advanced">
            <summary>{m.advanced}</summary>
            <div className="llm-advanced-body">
              <label>
                {m.llm}
                <select
                  value={profile.llm_provider ?? ''}
                  onChange={(e) =>
                    onSave({ llm_provider: e.target.value, llm_model: null })
                  }
                >
                  {profile.llm_provider === null && <option value="" />}
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {m.model}
                <select
                  value={profile.llm_model ?? activeProvider?.default_model ?? ''}
                  onChange={(e) => onSave({ llm_model: e.target.value })}
                >
                  {(activeProvider?.models.length
                    ? activeProvider.models
                    : [activeProvider?.default_model ?? '']
                  ).map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </div>
        <label className="profile-textarea">
          {m.exampleTextLabel}
          <textarea
            rows={8}
            value={example}
            onChange={(e) => setExample(e.target.value)}
            onBlur={() =>
              example !== profile.example_text && onSave({ example_text: example })
            }
          />
        </label>
        <label className="profile-textarea">
          {m.llmInstructionsLabel}
          <textarea
            rows={8}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() =>
              instructions !== profile.llm_instructions &&
              onSave({ llm_instructions: instructions })
            }
          />
          <span className="hint">{m.llmInstructionsHint}</span>
        </label>
      </div>
    </section>
  )
}
