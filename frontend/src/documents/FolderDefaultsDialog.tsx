import { useEffect, useState } from 'react'
import {
  getProfiles,
  HttpError,
  type Folder,
  type FolderDefaults,
} from '../api/client'
import { tierAllowed } from '../auth/policy'
import { Dialog } from '../ui/Dialog'
import { useMessages } from '../i18n'
import { languageLabel } from '../languages'
import { ownershipLabel } from '../ownership'
import { useStore } from '../state/store'
import { TIERS, type Language, type Profile, type Tier } from '../types'
import { saveFolderDefaults } from './folders'
import { refreshFolders } from './list'

/** New draft with the language default changed; a language change always
 * drops the profile default (profiles are per-language). */
// oxlint-disable-next-line react/only-export-components -- pure helper, unit-tested in isolation
export function withLanguageDefault(
  draft: FolderDefaults,
  language: Language | null,
): FolderDefaults {
  return {
    ...draft,
    default_language: language,
    default_profile_id:
      draft.default_language === language ? draft.default_profile_id : null,
  }
}

/** Snapshot of the header selection as folder defaults ("take from current"). */
// oxlint-disable-next-line react/only-export-components -- pure helper, unit-tested in isolation
export function defaultsFromHeader(s: {
  language: Language
  profileId: number | null
  domainIds: number[]
  provider: string
  model: string | null
  tier: Tier | null
  llmAuto: boolean
}): FolderDefaults {
  return {
    default_language: s.language,
    default_profile_id: s.profileId,
    default_domain_ids: [...s.domainIds],
    default_llm_provider: s.tier === null ? s.provider : null,
    default_llm_model: s.tier === null ? s.model : null,
    default_llm_tier: s.tier,
    default_llm_auto: s.llmAuto,
  }
}

function defaultsOf(folder: Folder): FolderDefaults {
  return {
    default_language: folder.default_language,
    default_profile_id: folder.default_profile_id,
    default_domain_ids: folder.default_domain_ids,
    default_llm_provider: folder.default_llm_provider,
    default_llm_model: folder.default_llm_model,
    default_llm_tier: folder.default_llm_tier,
    default_llm_auto: folder.default_llm_auto,
  }
}

export function FolderDefaultsDialog({
  folder,
  onClose,
}: {
  folder: Folder
  onClose: () => void
}) {
  const m = useMessages()
  const languages = useStore((s) => s.languages)
  const domains = useStore((s) => s.domains)
  const user = useStore((s) => s.user)
  const [draft, setDraft] = useState<FolderDefaults>(() => defaultsOf(folder))
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  const lang = draft.default_language
  useEffect(() => {
    if (lang === null) {
      setProfiles([])
      return
    }
    let cancelled = false
    setProfilesLoading(true)
    getProfiles(lang)
      .then((list) => {
        if (!cancelled) {
          setProfiles(list)
          setProfilesLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfiles([])
          setProfilesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [lang])

  // Pins enter the draft only via "take from current" (mirroring the header
  // selector, where pinning lives in the Advanced panel).
  const pinned =
    draft.default_llm_tier === null && draft.default_llm_provider !== null
  const llmValue = pinned ? 'pinned' : (draft.default_llm_tier ?? 'none')
  const domainIds = draft.default_domain_ids

  const toggleDomain = (id: number) => {
    const current = domainIds ?? []
    setDraft({
      ...draft,
      default_domain_ids: current.includes(id)
        ? current.filter((d) => d !== id)
        : [...current, id],
    })
  }

  const save = async () => {
    setSaving(true)
    setError(false)
    try {
      await saveFolderDefaults(folder.id, draft)
      onClose()
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        // Folder vanished meanwhile: the list is stale; drop it from view.
        void refreshFolders()
      }
      setError(true)
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={`${m.folderDefaults}: ${folder.name}`}
      onClose={onClose}
      className="folder-defaults-dialog"
    >
      <label>
          {m.language}
          <select
            className="fd-language"
            value={lang ?? 'none'}
            onChange={(e) =>
              setDraft(
                withLanguageDefault(
                  draft,
                  e.target.value === 'none'
                    ? null
                    : (e.target.value as Language),
                ),
              )
            }
          >
            <option value="none">{m.folderDefaultsNone}</option>
            {languages.map((info) => (
              <option key={info.code} value={info.code}>
                {languageLabel(info, m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.profile}
          <select
            className="fd-profile"
            disabled={lang === null || profilesLoading}
            value={draft.default_profile_id ?? 'none'}
            onChange={(e) =>
              setDraft({
                ...draft,
                default_profile_id:
                  e.target.value === 'none' ? null : Number(e.target.value),
              })
            }
          >
            <option value="none">{m.folderDefaultsNone}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {ownershipLabel(p.name, p.is_global, m)}
              </option>
            ))}
          </select>
        </label>
        <label className="fd-domains-toggle">
          <input
            type="checkbox"
            className="fd-domains-set"
            checked={domainIds !== null}
            onChange={(e) =>
              setDraft({
                ...draft,
                default_domain_ids: e.target.checked ? [] : null,
              })
            }
          />
          {m.domain}
        </label>
        {domainIds !== null && (
          <div className="fd-domain-list">
            {domains.map((domain) => (
              <label key={domain.id}>
                <input
                  type="checkbox"
                  checked={domainIds.includes(domain.id)}
                  onChange={() => toggleDomain(domain.id)}
                />
                {ownershipLabel(domain.name, domain.is_global, m)}
              </label>
            ))}
            {domains.length === 0 && <span className="dim">{m.domainNone}</span>}
          </div>
        )}
        <label>
          {m.llm}
          <select
            className="fd-llm"
            value={llmValue}
            onChange={(e) => {
              const value = e.target.value
              if (value === 'pinned') return
              setDraft({
                ...draft,
                default_llm_provider: null,
                default_llm_model: null,
                default_llm_tier: value === 'none' ? null : (value as Tier),
              })
            }}
          >
            <option value="none">{m.folderDefaultsNone}</option>
            {TIERS.map((tier) => {
              const notOnPlan = !tierAllowed(user, tier)
              return (
                <option key={tier} value={tier} disabled={notOnPlan}>
                  {m.tierName(tier)}
                  {notOnPlan ? m.planSuffix : ''}
                </option>
              )
            })}
            {pinned && (
              <option value="pinned">
                {m.tierPinnedOption(
                  draft.default_llm_model ?? draft.default_llm_provider ?? '',
                )}
              </option>
            )}
          </select>
        </label>
        <label>
          {m.folderDefaultsAuto}
          <select
            className="fd-auto"
            value={
              draft.default_llm_auto === null
                ? 'none'
                : draft.default_llm_auto
                  ? 'on'
                  : 'off'
            }
            onChange={(e) =>
              setDraft({
                ...draft,
                default_llm_auto:
                  e.target.value === 'none' ? null : e.target.value === 'on',
              })
            }
          >
            <option value="none">{m.folderDefaultsNone}</option>
            <option value="on">{m.folderDefaultsAutoOn}</option>
            <option value="off">{m.folderDefaultsAutoOff}</option>
          </select>
        </label>
        {error && <p className="fd-error">{m.folderDefaultsError}</p>}
        <div className="fd-buttons">
          <button
            className="fd-take-current"
            onClick={() => setDraft(defaultsFromHeader(useStore.getState()))}
          >
            {m.folderDefaultsTakeCurrent}
          </button>
          <span className="fd-spacer" />
          <button className="fd-cancel" onClick={onClose}>
            {m.folderDefaultsCancel}
          </button>
          <button
            className="fd-save"
            disabled={saving}
            onClick={() => void save()}
          >
            {m.folderDefaultsSave}
          </button>
        </div>
    </Dialog>
  )
}
