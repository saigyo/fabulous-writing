import { useMemo, useState } from 'react'
import { applySuggestion, selectFinding } from '../editor/editorRef'
import type { TrackedFinding } from '../editor/findings'
import { groupByCategory } from '../findings/group'
import { useStore } from '../state/store'
import type { Category, Finding } from '../types'

export function Sidebar() {
  const tracked = useStore((s) => s.tracked)
  const selectedId = useStore((s) => s.selectedId)
  const checkPhase = useStore((s) => s.checkPhase)
  const llmError = useStore((s) => s.llmError)
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set())

  const groups = useMemo(() => groupByCategory(withCurrentSpans(tracked)), [tracked])
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
      {llmError && <div className="llm-error">LLM check failed: {llmError}</div>}
      {total === 0 && checkPhase === 'idle' && (
        <p className="all-clear">No issues found. Fabulous!</p>
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
          {finding.suggestions.length > 0 && (
            <div className="suggestions">
              {finding.suggestions.map((suggestion) => (
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
          )}
        </div>
      )}
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
