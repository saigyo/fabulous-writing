import { useEffect, useRef, useState } from 'react'
import { resolveModel } from '../checking/routing'
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

  useEffect(() => {
    if (!advancedOpen) return
    function onClickOutside(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setAdvancedOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [advancedOpen])

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
            return (
              <option key={tier} value={tier} disabled={unavailable}>
                {m.tierName(tier)}
                {unavailable ? m.offlineSuffix : ''}
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
      <div className="llm-advanced">
        <button
          className="llm-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          {advancedOpen ? '▾' : '▸'} {m.advanced}
        </button>
        {advancedOpen && (
        <div className="llm-advanced-body">
          <label>
            {m.llm}
            <select
              value={shownProvider}
              onChange={(e) => store.setPinned(e.target.value, null)}
            >
              {store.providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.name}
                  {provider.available ? '' : m.offlineSuffix}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.model}
            <select
              value={shownModel}
              onChange={(e) => store.setPinned(shownProvider, e.target.value)}
            >
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          {!pinned && (
            <button
              className="llm-pin-button"
              onClick={() => {
                store.setPinned(shownProvider, shownModel || null)
                setAdvancedOpen(false)
              }}
            >
              {m.pinThisModel}
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
