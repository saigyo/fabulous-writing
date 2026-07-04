import { useMemo, useState } from 'react'
import { fetchRewrite, fetchSuggestions } from '../checking/suggest'
import { applyRewrite, applySuggestion, selectFinding } from '../editor/editorRef'
import type { TrackedFinding } from '../editor/findings'
import { groupByCategory } from '../findings/group'
import { countBySeverity, filterBySeverity, SEVERITIES } from '../findings/severity'
import { effectiveSuggestions } from '../findings/suggestions'
import { useStore } from '../state/store'
import type { Category, Finding } from '../types'

export function Sidebar() {
  const tracked = useStore((s) => s.tracked)
  const selectedId = useStore((s) => s.selectedId)
  const checkPhase = useStore((s) => s.checkPhase)
  const llmError = useStore((s) => s.llmError)
  const severityFilter = useStore((s) => s.severityFilter)
  const setSeverityFilter = useStore((s) => s.setSeverityFilter)
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set())

  const findings = useMemo(() => withCurrentSpans(tracked), [tracked])
  const counts = useMemo(() => countBySeverity(findings), [findings])
  const groups = useMemo(
    () => groupByCategory(filterBySeverity(findings, severityFilter)),
    [findings, severityFilter],
  )
  const total = tracked.length

  function toggle(category: Category) {
    setCollapsed((old) => {
      const next = new Set(old)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>
          Findings <span className="count-badge">{total}</span>
        </h2>
        {checkPhase !== 'idle' && (
          <span className="check-status">
            {checkPhase === 'llm' ? 'LLM checking…' : 'checking…'}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="severity-filter">
          {SEVERITIES.map((severity) => (
            <button
              key={severity}
              className={`severity-filter-button severity-${severity}${
                severityFilter === severity ? ' active' : ''
              }`}
              title={
                severityFilter === severity
                  ? 'Click to show all findings again'
                  : `Show only ${severity}s`
              }
              onClick={() =>
                setSeverityFilter(severityFilter === severity ? null : severity)
              }
            >
              {counts[severity]} {severity}
              {counts[severity] === 1 ? '' : 's'}
            </button>
          ))}
        </div>
      )}
      {llmError && <div className="llm-error">LLM check failed: {llmError}</div>}
      {total === 0 && checkPhase === 'idle' && (
        <p className="all-clear">No issues found. Fabulous!</p>
      )}
      {total > 0 && groups.length === 0 && (
        <p className="all-clear">No {severityFilter}s among the current findings.</p>
      )}
      {groups.map((group) => (
        <section key={group.category} className="category-group">
          <button className="category-title" onClick={() => toggle(group.category)}>
            <span className={`category-dot fw-${group.category}`} />
            {group.category}
            <span className="count-badge">{group.findings.length}</span>
            <span className="chevron">{collapsed.has(group.category) ? '▸' : '▾'}</span>
          </button>
          {!collapsed.has(group.category) &&
            group.findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                selected={finding.id === selectedId}
              />
            ))}
        </section>
      ))}
    </aside>
  )
}

function FindingRow({ finding, selected }: { finding: Finding; selected: boolean }) {
  return (
    <div
      className={`finding-row${selected ? ' selected' : ''}`}
      onClick={() => selectFinding(selected ? null : finding.id)}
    >
      <div className="finding-quote">
        “{truncate(finding.span.text, 60)}”
        <span className={`severity severity-${finding.severity}`}>
          {finding.severity}
        </span>
      </div>
      {selected && (
        <div className="finding-detail">
          <p className="finding-message">{finding.message}</p>
          <p className="finding-source">
            {finding.source === 'llm' ? 'LLM' : finding.source}
            {finding.rule_id ? ` · ${finding.rule_id}` : ''}
          </p>
          <SuggestionArea finding={finding} />
          <RewriteArea finding={finding} />
        </div>
      )}
    </div>
  )
}

function SuggestionArea({ finding }: { finding: Finding }) {
  const extras = useStore((s) => s.extraSuggestions)
  const pending = useStore((s) => s.suggestPendingId === finding.id)
  const anyPending = useStore(
    (s) => s.suggestPendingId !== null || s.rewritePendingId !== null,
  )
  const error = useStore((s) => s.suggestErrors[finding.id])
  const suggestions = effectiveSuggestions(finding, extras)
  const fetched = finding.id in extras

  if (suggestions.length > 0) {
    return (
      <div className="suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            className="suggestion-button"
            onClick={(event) => {
              event.stopPropagation()
              applySuggestion(finding.id, suggestion)
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    )
  }
  if (pending) {
    return <p className="suggest-status">✨ asking LLM…</p>
  }
  if (fetched) {
    return <p className="suggest-status">The LLM found no replacement.</p>
  }
  return (
    <div className="suggestions">
      <button
        className="suggestion-button suggest-fix"
        disabled={anyPending}
        onClick={(event) => {
          event.stopPropagation()
          void fetchSuggestions(finding.id)
        }}
      >
        ✨ {error ? 'Retry suggestion' : 'Suggest fix'}
      </button>
      {error && <p className="suggest-error">{error}</p>}
    </div>
  )
}

function RewriteArea({ finding }: { finding: Finding }) {
  const rewrite = useStore((s) => s.rewrites[finding.id])
  const pending = useStore((s) => s.rewritePendingId === finding.id)
  const anyPending = useStore(
    (s) => s.suggestPendingId !== null || s.rewritePendingId !== null,
  )
  const error = useStore((s) => s.rewriteErrors[finding.id])

  function apply(option: string) {
    if (!rewrite) return
    if (!applyRewrite(finding.id, rewrite.original, option)) {
      const store = useStore.getState()
      store.setRewrite(finding.id, null)
      store.setRewriteError(finding.id, 'The sentence changed — rewrite again.')
    }
  }

  if (pending) {
    return <p className="suggest-status">↻ rewriting sentence…</p>
  }
  if (rewrite && rewrite.options.length > 0) {
    return (
      <div className="rewrites">
        {rewrite.options.map((option) => (
          <button
            key={option}
            className="rewrite-option"
            title="Replace the sentence with this rewrite"
            onClick={(event) => {
              event.stopPropagation()
              apply(option)
            }}
          >
            {option}
          </button>
        ))}
      </div>
    )
  }
  if (rewrite) {
    return <p className="suggest-status">The LLM offered no rewrite.</p>
  }
  return (
    <div className="rewrites">
      <button
        className="suggestion-button suggest-fix"
        disabled={anyPending}
        onClick={(event) => {
          event.stopPropagation()
          void fetchRewrite(finding.id)
        }}
      >
        ↻ {error ? 'Retry rewrite' : 'Rewrite sentence'}
      </button>
      {error && <p className="suggest-error">{error}</p>}
    </div>
  )
}

function withCurrentSpans(tracked: TrackedFinding[]): Finding[] {
  return tracked.map((item) => ({
    ...item.finding,
    span: { ...item.finding.span, start: item.from, end: item.to },
  }))
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
