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
  const entryFor = (tier: Tier) => store.routing?.languages[store.language]?.[tier]
  const resolution = resolveModel(store)
  const activeProvider = store.providers.find((p) => p.name === store.provider)
  const pinned = store.tier === null

  return (
    <div className="llm-selector">
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
            const unavailable = !entry || !entry.available
            return (
              <option key={tier} value={tier} disabled={unavailable}>
                {m.tierName(tier)}
                {unavailable ? m.offlineSuffix : ''}
              </option>
            )
          })}
          {pinned && (
            <option value="pinned">
              {m.tierPinnedOption(
                store.model ?? activeProvider?.default_model ?? store.provider,
              )}
            </option>
          )}
        </select>
      </label>
      <span
        className={`llm-resolved${resolution.ok ? '' : ' llm-resolved-error'}`}
        title={resolution.ok ? undefined : resolution.reason}
      >
        {resolution.ok
          ? m.resolvedModel(resolution.model ?? '', resolution.provider)
          : m.llmSkipped(resolution.reason)}
      </span>
      <details className="llm-advanced">
        <summary>{m.advanced}</summary>
        <div className="llm-advanced-body">
          <label>
            {m.llm}
            <select
              value={store.provider}
              onChange={(e) => store.setProvider(e.target.value)}
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
              value={store.model ?? activeProvider?.default_model ?? ''}
              onChange={(e) => store.setModel(e.target.value)}
            >
              {(activeProvider?.models.length
                ? activeProvider.models
                : [activeProvider?.default_model ?? '']
              ).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
    </div>
  )
}
