import { useEffect, useState } from 'react'
import { getRules, type RulesResponse } from '../api/client'
import { useStore } from '../state/store'
import type { RuleInfo } from '../types'
import { groupRulesByCategory, ruleDetailSummary } from './catalog'

export function RulesView() {
  const language = useStore((s) => s.language)
  const languages = useStore((s) => s.languages)
  const [response, setResponse] = useState<RulesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setResponse(null)
    setError(null)
    getRules(language)
      .then(setResponse)
      .catch((e: Error) => setError(e.message))
  }, [language])

  const languageName =
    languages.find((info) => info.code === language)?.name ?? language

  return (
    <div className="rules-view">
      <header className="rules-header">
        <h2>
          Rules · {languageName}
          {response && <span className="rules-count">{response.rules.length}</span>}
        </h2>
        <p className="rules-hint">
          Deterministic checks for the language selected in the header. Rules live
          in <code>backend/rules/{language}/</code> and reload on server restart or{' '}
          <code>POST /api/rules/reload</code>.
        </p>
      </header>
      {error && <p className="rules-error">Could not load rules: {error}</p>}
      {response && response.errors.length > 0 && (
        <section className="rules-load-errors">
          <h3>Files with errors</h3>
          {response.errors.map((err) => (
            <p key={err.file}>
              <code>{err.file}</code>: {err.error}
            </p>
          ))}
        </section>
      )}
      {response &&
        groupRulesByCategory(response.rules).map((group) => (
          <section key={group.category} className="rules-group">
            <h3 className={`category-${group.category}`}>{group.category}</h3>
            {group.rules.map((rule) => (
              <RuleCard key={rule.rule_id} rule={rule} />
            ))}
          </section>
        ))}
    </div>
  )
}

function RuleCard({ rule }: { rule: RuleInfo }) {
  const isPattern = rule.extends === 'token_pattern' || rule.extends === 'dependency'
  return (
    <article className="rule-card">
      <div className="rule-card-head">
        <span className="rule-name">{rule.rule_id}</span>
        <span className="rule-badge type">{rule.extends}</span>
        {rule.requires_nlp && (
          <span className="rule-badge nlp" title="Needs the language's spaCy model">
            NLP
          </span>
        )}
        <span className={`rule-badge level-${rule.level}`}>{rule.level}</span>
      </div>
      <p className="rule-message">{rule.message}</p>
      <p className="rule-detail">{ruleDetailSummary(rule)}</p>
      {isPattern && (
        <details className="rule-pattern">
          <summary>Pattern</summary>
          <pre>{JSON.stringify(rule.detail.pattern, null, 2)}</pre>
        </details>
      )}
    </article>
  )
}
