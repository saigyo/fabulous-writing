import { useRef, useState } from 'react'
import { modelAllowed, providerAllowed, tierAllowed, llmDisabled } from '../auth/policy'
import { resolveModel } from '../checking/routing'
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { TIERS, type Tier } from '../types'

/**
 * Tier-first LLM selection: the visible control is a quality-tier dropdown
 * with the resolved model shown beneath; the concrete provider/model
 * dropdowns live in a collapsed Advanced panel and act as a pin (tier mode
 * off) — mirroring the profile editor. Unavailable tiers are disabled with
 * the reason, never silently degraded.
 */
export function LlmSelector() {
  const store = useStore()
  const m = useMessages()
  // Popover state à la DomainMultiSelect: native <details> would stay open
  // on outside clicks, which reads as broken for an overlay.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismissOnOutsideClick(ref, advancedOpen, () => setAdvancedOpen(false))

  const user = store.user
  // The §6.2 floor hides the whole LLM phase — after the hooks above, so
  // React's rules of hooks hold regardless of which branch this takes.
  if (llmDisabled(user)) return null

  const entryFor = (tier: Tier) => store.routing?.languages[store.language]?.[tier]
  const resolution = resolveModel(store)
  const pinned = store.tier === null
  const routingLoaded = store.routing !== null

  // The Advanced panel shows what a check would actually use: the tier's
  // resolved pair in tier mode, the pin itself in pinned mode — not the
  // stale last-pinned values. "Pin this model" adopts the displayed pair.
  const shownProvider =
    !pinned && resolution.ok ? resolution.provider : store.provider
  const shownProviderInfo = store.providers.find((p) => p.name === shownProvider)
  const shownModel =
    (!pinned && resolution.ok ? resolution.model : store.model) ??
    shownProviderInfo?.default_model ??
    ''
  // A tier's resolved model may be missing from the discovered list (e.g.
  // discovery fell back to the provider default) — keep the select honest.
  const modelOptions = shownProviderInfo?.models.length
    ? shownProviderInfo.models.includes(shownModel)
      ? shownProviderInfo.models
      : [shownModel, ...shownProviderInfo.models]
    : [shownModel]

  return (
    <div className="llm-selector" ref={ref}>
      <div className="llm-select-row">
        <label>
          {m.llm}
          <select
            value={store.tier ?? 'pinned'}
            onChange={(e) => {
              if (e.target.value !== 'pinned') store.setTier(e.target.value as Tier)
            }}
          >
            {TIERS.map((tier) => {
              const entry = entryFor(tier)
              // Unknown availability (routing not loaded / fetch failed) must
              // not dead-lock the control — resolution still fails explicitly
              // at check time.
              const unavailable = routingLoaded && (!entry || !entry.available)
              const notOnPlan = !tierAllowed(user, tier)
              return (
                <option key={tier} value={tier} disabled={unavailable || notOnPlan}>
                  {m.tierName(tier)}
                  {notOnPlan ? m.planSuffix : unavailable ? m.offlineSuffix : ''}
                </option>
              )
            })}
            {pinned && (
              <option value="pinned">
                {m.tierPinnedOption(shownModel || store.provider)}
              </option>
            )}
          </select>
        </label>
        <button
          className="icon-button llm-advanced-toggle"
          title={m.advancedTitle}
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <GearIcon />
        </button>
      </div>
      {(store.tier === null || routingLoaded) && (
        <span
          className={`llm-resolved${resolution.ok ? '' : ' llm-resolved-error'}`}
          title={resolution.ok ? undefined : resolution.reason}
        >
          {resolution.ok
            ? m.resolvedModel(resolution.model ?? '', resolution.provider)
            : m.llmSkipped(resolution.reason)}
        </span>
      )}
      {advancedOpen && (
        <div className="llm-advanced-body">
          <label>
            {m.llm}
            <select
              value={shownProvider}
              onChange={(e) => store.setPinned(e.target.value, null)}
            >
              {store.providers.map((provider) => {
                const notOnPlan = !providerAllowed(user, provider.name)
                return (
                  <option
                    key={provider.name}
                    value={provider.name}
                    disabled={notOnPlan}
                  >
                    {provider.name}
                    {notOnPlan
                      ? m.planSuffix
                      : provider.available
                        ? ''
                        : m.offlineSuffix}
                  </option>
                )
              })}
            </select>
          </label>
          <label>
            {m.model}
            <select
              value={shownModel}
              onChange={(e) => store.setPinned(shownProvider, e.target.value)}
            >
              {modelOptions.map((model) => {
                const notOnPlan = !modelAllowed(user, shownProvider, model)
                return (
                  <option key={model} value={model} disabled={notOnPlan}>
                    {model}
                    {notOnPlan ? m.planSuffix : ''}
                  </option>
                )
              })}
            </select>
          </label>
          {!pinned && modelAllowed(user, shownProvider, shownModel) && (
            <button
              className="icon-button llm-pin-button"
              title={m.pinThisModel}
              onClick={() => {
                store.setPinned(shownProvider, shownModel || null)
                setAdvancedOpen(false)
              }}
            >
              <PinIcon />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}
