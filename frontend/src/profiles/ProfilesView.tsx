import { useEffect, useState } from 'react'
import {
  createProfile,
  deleteProfile,
  getRules,
  resetProfile,
  updateProfile,
} from '../api/client'
import { currentGeneration } from '../documents/autosave'
import { PinIcon } from '../header/LlmSelector'
import { useCrudError } from '../hooks/useCrudError'
import { useMessages } from '../i18n'
import { ownershipLabel } from '../ownership'
import { useStore } from '../state/store'
import { TIERS, type Profile, type Tier } from '../types'
import { resolveProfileModel } from './profile'

export function ProfilesView() {
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const language = useStore((s) => s.language)
  const m = useMessages()
  const [newName, setNewName] = useState('')
  const { error, run } = useCrudError(m.profileChangeFailed)
  const [packs, setPacks] = useState<string[]>([])

  useEffect(() => {
    getRules(language)
      .then((response) => setPacks(response.packs))
      .catch(() => setPacks([]))
  }, [language])

  const selected = profiles.find((p) => p.id === profileId) ?? null

  // Every caller below has already checked its own generation guard and
  // built `next` from a fresh store read, so this itself needs no guard.
  function refresh(next: Profile[], select?: Profile) {
    const store = useStore.getState()
    store.setProfiles(next)
    if (select) store.selectProfile(select, true)
  }

  async function create() {
    if (!newName.trim()) return
    const state = useStore.getState()
    const base = selected
    // Captured before the request goes out: a session ending mid-request
    // must not land this write in the incoming session's store.
    const gen = currentGeneration()
    await run(async () => {
      const created = await createProfile({
        language,
        name: newName.trim(),
        categories_off: base?.categories_off ?? [],
        rule_exceptions: base?.rule_exceptions ?? [],
        packs_on: base?.packs_on ?? [],
        domain_ids: state.domainIds,
        llm_tier: state.tier,
        llm_provider: state.tier === null ? state.provider : null,
        llm_model: state.tier === null ? state.model : null,
        llm_instructions: base?.llm_instructions ?? '',
        example_text: base?.example_text ?? '',
      })
      if (gen !== currentGeneration()) return // session ended: do not write
      setNewName('')
      // Reads `profiles` fresh (not the pre-await closure above) so this
      // can't clobber a `profiles` update that landed while the request was
      // in flight.
      refresh([...useStore.getState().profiles, created], created)
    })
  }

  async function save(profile: Profile, patch: Partial<Profile>) {
    const merged = { ...profile, ...patch }
    const gen = currentGeneration()
    await run(async () => {
      const saved = await updateProfile(profile.id, {
        name: merged.name,
        categories_off: merged.categories_off,
        rule_exceptions: merged.rule_exceptions,
        packs_on: merged.packs_on,
        domain_ids: merged.domain_ids,
        llm_tier: merged.llm_tier,
        llm_provider: merged.llm_provider,
        llm_model: merged.llm_model,
        llm_instructions: merged.llm_instructions,
        example_text: merged.example_text,
      })
      if (gen !== currentGeneration()) return // session ended: do not write
      const s = useStore.getState()
      refresh(
        s.profiles.map((p) => (p.id === saved.id ? saved : p)),
        saved.id === s.profileId ? saved : undefined,
      )
    })
  }

  async function remove(profile: Profile) {
    const gen = currentGeneration()
    await run(async () => {
      await deleteProfile(profile.id)
      if (gen !== currentGeneration()) return // session ended: do not write
      const s = useStore.getState()
      const rest = s.profiles.filter((p) => p.id !== profile.id)
      const fallback = rest.find((p) => p.is_standard) ?? rest[0]
      refresh(rest, profile.id === s.profileId ? fallback : undefined)
    })
  }

  async function reset(profile: Profile) {
    const gen = currentGeneration()
    await run(async () => {
      const restored = await resetProfile(profile.id)
      if (gen !== currentGeneration()) return // session ended: do not write
      const s = useStore.getState()
      refresh(
        s.profiles.map((p) => (p.id === restored.id ? restored : p)),
        restored.id === s.profileId ? restored : undefined,
      )
    })
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
            packs={packs}
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
  packs,
  onSave,
  onDelete,
  onReset,
}: {
  profile: Profile
  active: boolean
  packs: string[]
  onSave: (patch: Partial<Profile>) => void
  onDelete: () => void
  onReset: () => void
}) {
  const m = useMessages()
  const providers = useStore((s) => s.providers)
  const routing = useStore((s) => s.routing)
  const domains = useStore((s) => s.domains)
  const isAdmin = useStore((s) => s.user?.is_admin ?? false)
  const readOnly = profile.is_global && !isAdmin
  const [name, setName] = useState(profile.name)
  const [instructions, setInstructions] = useState(profile.llm_instructions)
  const [example, setExample] = useState(profile.example_text)

  // Belt for the `disabled` attributes below: a control that somehow still
  // fires (or a future control that forgets `disabled`) can't reach onSave.
  function guardedSave(patch: Partial<Profile>) {
    if (readOnly) return
    onSave(patch)
  }

  // Mirror the header's Advanced panel: display what a check with this
  // profile would actually use — the tier's resolved pair in tier mode,
  // the pin itself in pinned mode.
  const resolution = resolveProfileModel(profile, providers, routing)
  const pinnedProfile = profile.llm_provider !== null
  const routingLoaded = routing !== null
  const shownProvider =
    !pinnedProfile && resolution?.ok
      ? resolution.provider
      : (profile.llm_provider ?? '')
  const shownProviderInfo = providers.find((p) => p.name === shownProvider)
  const shownModel =
    (!pinnedProfile && resolution?.ok ? resolution.model : profile.llm_model) ??
    shownProviderInfo?.default_model ??
    ''
  const modelOptions = shownProviderInfo?.models.length
    ? shownProviderInfo.models.includes(shownModel)
      ? shownProviderInfo.models
      : [shownModel, ...shownProviderInfo.models]
    : [shownModel]

  return (
    <section className={`profile-card${active ? ' selected' : ''}`}>
      <div className="profile-card-title">
        <input
          value={name}
          disabled={readOnly || profile.is_standard}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== profile.name && guardedSave({ name })}
        />
        {profile.is_global && (
          <span className="global-badge" title={m.globalBadgeTitle}>
            {m.globalBadge}
          </span>
        )}
        {!readOnly &&
          (profile.is_standard ? (
            <button className="icon-button" title={m.resetStandardTitle} onClick={onReset}>↺</button>
          ) : (
            <button className="icon-button" title={m.deleteProfileTitle} onClick={onDelete}>✕</button>
          ))}
      </div>
      {/* A shared grid: row 1 holds domain (left) and the LLM selectors
          (right), row 2 the two text boxes — so their labels and upper
          boundaries always align across the columns. */}
      <div className="profile-card-columns">
        <label className="profile-card-domain">
          {m.domain}
          <select
            multiple
            disabled={readOnly}
            value={profile.domain_ids.map(String)}
            onChange={(e) =>
              guardedSave({
                domain_ids: [...e.target.selectedOptions].map((o) => Number(o.value)),
              })
            }
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>{ownershipLabel(d.name, d.is_global, m)}</option>
            ))}
          </select>
        </label>
        <div className="profile-card-llm">
          <span className="field-label">{m.llm}</span>
          <div className="tier-options" role="radiogroup">
            {TIERS.map((tier) => (
              <button
                key={tier}
                disabled={readOnly}
                className={`tier-option${
                  profile.llm_provider === null && profile.llm_tier === tier
                    ? ' selected'
                    : ''
                }`}
                onClick={() =>
                  guardedSave({ llm_tier: tier, llm_provider: null, llm_model: null })
                }
              >
                {m.tierName(tier as Tier)}
              </button>
            ))}
          </div>
          {resolution && (pinnedProfile || routingLoaded) && (
            <span
              className={`llm-resolved${resolution.ok ? '' : ' llm-resolved-error'}`}
              title={resolution.ok ? undefined : resolution.reason}
            >
              {resolution.ok
                ? m.resolvedModel(resolution.model ?? '', resolution.provider)
                : m.llmSkipped(resolution.reason)}
            </span>
          )}
          {profile.llm_provider !== null && (
            <p className="pinned-note">
              {m.pinnedNote}
              <button
                className="icon-button"
                disabled={readOnly}
                title={m.clearPin}
                onClick={() => guardedSave({ llm_provider: null, llm_model: null })}
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
                  disabled={readOnly}
                  value={shownProvider}
                  onChange={(e) =>
                    guardedSave({ llm_provider: e.target.value, llm_model: null })
                  }
                >
                  {shownProvider === '' && <option value="" />}
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {m.model}
                <select
                  disabled={readOnly}
                  value={shownModel}
                  onChange={(e) =>
                    guardedSave({
                      llm_provider: shownProvider || null,
                      llm_model: e.target.value || null,
                    })
                  }
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </label>
              {!pinnedProfile && resolution?.ok && (
                <button
                  className="icon-button llm-pin-button"
                  disabled={readOnly}
                  title={m.pinThisModel}
                  onClick={() =>
                    guardedSave({
                      llm_provider: shownProvider,
                      llm_model: shownModel || null,
                    })
                  }
                >
                  <PinIcon />
                </button>
              )}
            </div>
          </details>
          {packs.length > 0 && (
            <div className="profile-card-packs">
              <span className="field-label">{m.rulePacks}</span>
              <div className="tier-options">
                {packs.map((pack) => {
                  const on = profile.packs_on.includes(pack)
                  return (
                    <button
                      key={pack}
                      disabled={readOnly}
                      className={`tier-option${on ? ' selected' : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        guardedSave({
                          packs_on: on
                            ? profile.packs_on.filter((p) => p !== pack)
                            : [...profile.packs_on, pack],
                        })
                      }
                    >
                      {m.packName(pack)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <label className="profile-textarea">
          {m.exampleTextLabel}
          <textarea
            rows={8}
            disabled={readOnly}
            value={example}
            onChange={(e) => setExample(e.target.value)}
            onBlur={() =>
              example !== profile.example_text && guardedSave({ example_text: example })
            }
          />
        </label>
        <label className="profile-textarea">
          {m.llmInstructionsLabel}
          <textarea
            rows={8}
            disabled={readOnly}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() =>
              instructions !== profile.llm_instructions &&
              guardedSave({ llm_instructions: instructions })
            }
          />
          <span className="hint">{m.llmInstructionsHint}</span>
        </label>
      </div>
    </section>
  )
}
