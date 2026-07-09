import { Fragment, useEffect, useState } from 'react'
import { getRules, updateProfile, type RulesResponse } from '../api/client'
import { interpolate, useMessages } from '../i18n'
import { isRuleActive } from '../profiles/profile'
import { useStore } from '../state/store'
import type { Category, RuleInfo } from '../types'
import { ruleDetailSummary, splitByPack } from './catalog'

export function RulesView() {
  const language = useStore((s) => s.language)
  const languages = useStore((s) => s.languages)
  const profiles = useStore((s) => s.profiles)
  const profileId = useStore((s) => s.profileId)
  const profile = profiles.find((p) => p.id === profileId) ?? null
  const m = useMessages()
  const [response, setResponse] = useState<RulesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rulesCollapsed = useStore((s) => s.rulesCollapsed)
  const toggleCollapsed = useStore((s) => s.toggleRuleSection)
  const setRulesCollapsed = useStore((s) => s.setRulesCollapsed)
  const collapsed = new Set(rulesCollapsed)

  useEffect(() => {
    setResponse(null)
    setError(null)
    getRules(language)
      .then(setResponse)
      // `error` holds an already-formatted message (this path and
      // saveRuleSelection use different wordings), so format at set-time.
      .catch((e: Error) => setError(m.couldNotLoadRules(e.message)))
    // `m` is the per-locale catalog (stable identity): this refires only on a
    // real locale switch, which also re-formats the error in the new language.
  }, [language, m])

  const languageName =
    languages.find((info) => info.code === language)?.name ?? language

  async function saveRuleSelection(patch: {
    categories_off?: Category[]
    rule_exceptions?: string[]
    packs_on?: string[]
  }) {
    if (!profile) return
    try {
      const saved = await updateProfile(profile.id, {
        name: profile.name,
        categories_off: patch.categories_off ?? profile.categories_off,
        rule_exceptions: patch.rule_exceptions ?? profile.rule_exceptions,
        packs_on: patch.packs_on ?? profile.packs_on,
        domain_ids: profile.domain_ids,
        llm_provider: profile.llm_provider,
        llm_model: profile.llm_model,
        llm_tier: profile.llm_tier,
        llm_instructions: profile.llm_instructions,
        example_text: profile.example_text,
      })
      useStore.getState().setProfiles(
        useStore.getState().profiles.map((p) => (p.id === saved.id ? saved : p)),
      )
      setError(null)
    } catch (e) {
      setError(m.profileChangeFailed(e instanceof Error ? e.message : String(e)))
    }
  }

  function toggleCategory(category: Category, rulesInCategory: RuleInfo[]) {
    if (!profile) return
    const off = profile.categories_off.includes(category)
    void saveRuleSelection({
      categories_off: off
        ? profile.categories_off.filter((c) => c !== category)
        : [...profile.categories_off, category],
      // Toggling a category clears its exceptions (fresh start).
      rule_exceptions: profile.rule_exceptions.filter(
        (id) => !rulesInCategory.some((r) => r.rule_id === id),
      ),
    })
  }

  function toggleRule(ruleId: string) {
    if (!profile) return
    const isException = profile.rule_exceptions.includes(ruleId)
    void saveRuleSelection({
      rule_exceptions: isException
        ? profile.rule_exceptions.filter((id) => id !== ruleId)
        : [...profile.rule_exceptions, ruleId],
    })
  }

  function togglePack(pack: string, rulesInPack: RuleInfo[]) {
    if (!profile) return
    const on = profile.packs_on.includes(pack)
    void saveRuleSelection({
      packs_on: on
        ? profile.packs_on.filter((p) => p !== pack)
        : [...profile.packs_on, pack],
      rule_exceptions: profile.rule_exceptions.filter(
        (id) => !rulesInPack.some((r) => r.rule_id === id),
      ),
    })
  }

  const split = response ? splitByPack(response.rules) : null
  const sectionKeys = split
    ? [
        ...split.general.map((group) => group.category as string),
        ...split.packs.map((section) => `pack:${section.pack}`),
      ]
    : []

  return (
    <div className="rules-view">
      <header className="rules-header">
        <h2>
          {m.rulesTitle} · {languageName}
          {response && <span className="rules-count">{response.rules.length}</span>}
          {split && (
            <>
              <button
                className="rules-fold"
                title={m.expandAllTitle}
                onClick={() => setRulesCollapsed([])}
              >
                <ExpandAllIcon />
              </button>
              <button
                className="rules-fold"
                title={m.collapseAllTitle}
                onClick={() => setRulesCollapsed(sectionKeys)}
              >
                <CollapseAllIcon />
              </button>
            </>
          )}
        </h2>
        <p className="rules-hint">
          {interpolate(m.rulesHint, {
            path: <code>backend/rules/{language}/</code>,
            endpoint: <code>POST /api/rules/reload</code>,
          }).map((part, i) => (
            <Fragment key={i}>{part}</Fragment>
          ))}
        </p>
        {profile && (
          <p className="rules-profile-banner">
            {m.editingRulesFor(profile.name, languageName)}
          </p>
        )}
      </header>
      {error && <p className="rules-error">{error}</p>}
      {response && response.errors.length > 0 && (
        <section className="rules-load-errors">
          <h3>{m.filesWithErrors}</h3>
          {response.errors.map((err) => (
            <p key={err.file}>
              <code>{err.file}</code>: {err.error}
            </p>
          ))}
        </section>
      )}
      {split &&
        split.general.map((group) => (
          <section key={group.category} className="rules-group">
            <h3>
              <input
                type="checkbox"
                title={m.categoryToggleTitle}
                checked={!profile?.categories_off.includes(group.category)}
                disabled={!profile}
                onChange={() => toggleCategory(group.category, group.rules)}
              />
              <button
                className="rules-collapse"
                aria-expanded={!collapsed.has(group.category)}
                onClick={() => toggleCollapsed(group.category)}
              >
                <span className={`category-dot fw-${group.category}`} />
                {m.categoryName(group.category)}
                <span className="count-badge">{group.rules.length}</span>
                <span className="chevron">
                  {collapsed.has(group.category) ? '▸' : '▾'}
                </span>
              </button>
            </h3>
            {!collapsed.has(group.category) &&
              group.rules.map((rule) => (
              <RuleCard
                key={rule.rule_id}
                rule={rule}
                active={
                  profile
                    ? isRuleActive(profile, group.category, rule.rule_id, rule.pack)
                    : true
                }
                onToggle={() => toggleRule(rule.rule_id)}
                canToggle={profile !== null}
              />
            ))}
          </section>
        ))}
      {split &&
        split.packs.map((section) => (
          <section key={section.pack} className="rules-group rules-pack">
            <h3>
              <input
                type="checkbox"
                title={m.packToggleTitle}
                checked={profile?.packs_on.includes(section.pack) ?? false}
                disabled={!profile}
                onChange={() => togglePack(section.pack, section.rules)}
              />
              <button
                className="rules-collapse"
                aria-expanded={!collapsed.has(`pack:${section.pack}`)}
                onClick={() => toggleCollapsed(`pack:${section.pack}`)}
              >
                <span className="category-dot" />
                {m.packName(section.pack)}
                <span className="rule-badge pack">{m.rulePacks}</span>
                <span className="count-badge">{section.rules.length}</span>
                <span className="chevron">
                  {collapsed.has(`pack:${section.pack}`) ? '▸' : '▾'}
                </span>
              </button>
            </h3>
            {!collapsed.has(`pack:${section.pack}`) &&
              section.rules.map((rule) => (
              <RuleCard
                key={rule.rule_id}
                rule={rule}
                active={
                  profile
                    ? isRuleActive(profile, rule.category, rule.rule_id, rule.pack)
                    : false
                }
                onToggle={() => toggleRule(rule.rule_id)}
                canToggle={profile !== null}
              />
            ))}
          </section>
        ))}
    </div>
  )
}

function ExpandAllIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4,6 8,2.5 12,6" />
      <polyline points="4,10 8,13.5 12,10" />
    </svg>
  )
}

function CollapseAllIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4,2.5 8,6 12,2.5" />
      <polyline points="4,13.5 8,10 12,13.5" />
    </svg>
  )
}

function RuleCard({
  rule,
  active,
  onToggle,
  canToggle,
}: {
  rule: RuleInfo
  active: boolean
  onToggle: () => void
  canToggle: boolean
}) {
  const m = useMessages()
  const isPattern = rule.extends === 'token_pattern' || rule.extends === 'dependency'
  return (
    <article className={`rule-card${active ? '' : ' rule-inactive'}`}>
      <div className="rule-card-head">
        <input
          type="checkbox"
          title={m.ruleToggleTitle}
          checked={active}
          disabled={!canToggle}
          onChange={onToggle}
        />
        <span className="rule-name">{rule.rule_id}</span>
        <span className="rule-badge type">{rule.extends}</span>
        {rule.requires_nlp && (
          <span className="rule-badge nlp" title={m.nlpBadgeTitle}>
            NLP
          </span>
        )}
        <span className={`rule-badge level-${rule.level}`}>
          {m.severityName(rule.level)}
        </span>
      </div>
      <p className="rule-message">{rule.message}</p>
      <p className="rule-detail">{ruleDetailSummary(rule, m)}</p>
      <div className="rule-examples">
        {rule.examples.bad.map((sentence) => (
          <p key={sentence} className="rule-example bad">
            <span className="rule-example-mark">✗ {m.exampleFlagged}</span>
            {sentence}
          </p>
        ))}
        {rule.examples.good.map((sentence) => (
          <p key={sentence} className="rule-example good">
            <span className="rule-example-mark">✓ {m.exampleNotFlagged}</span>
            {sentence}
          </p>
        ))}
      </div>
      {isPattern && (
        <details className="rule-pattern">
          <summary>{m.pattern}</summary>
          <pre>{JSON.stringify(rule.detail.pattern, null, 2)}</pre>
        </details>
      )}
    </article>
  )
}
