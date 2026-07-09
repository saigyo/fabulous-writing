import { useEffect, useMemo, useRef, useState } from 'react'
import type { HeldBackSuggestion } from '../api/client'
import { llmStatusLabel } from '../checking/status'
import { fetchRewrite, fetchSuggestions } from '../checking/suggest'
import { heldBackReason } from '../checking/vetMessage'
import { applyRewrite, applySuggestion, selectFinding } from '../editor/editorRef'
import type { TrackedFinding } from '../editor/findings'
import { groupByCategory } from '../findings/group'
import { countBySeverity, filterBySeverity, SEVERITIES } from '../findings/severity'
import {
  countBySourceGroup,
  filterBySourceGroup,
  SOURCE_GROUPS,
  sourceGroupOf,
} from '../findings/source'
import { effectiveSuggestions } from '../findings/suggestions'
import { useMessages } from '../i18n'
import { ScoreBadge, ScorePanel } from './Score'
import { useStore } from '../state/store'
import type { Category, Finding } from '../types'

const NO_HELD_BACK: never[] = []

export function Sidebar() {
  const tracked = useStore((s) => s.tracked)
  const selectedId = useStore((s) => s.selectedId)
  const checkPhase = useStore((s) => s.checkPhase)
  const llmError = useStore((s) => s.llmError)
  const severityFilter = useStore((s) => s.severityFilter)
  const setSeverityFilter = useStore((s) => s.setSeverityFilter)
  const sourceFilter = useStore((s) => s.sourceFilter)
  const setSourceFilter = useStore((s) => s.setSourceFilter)
  const m = useMessages()
  const [collapsed, setCollapsed] = useState<Set<Category>>(new Set())
  const [scoreOpen, setScoreOpen] = useState(false)

  const findings = useMemo(() => withCurrentSpans(tracked), [tracked])
  const counts = useMemo(() => countBySeverity(findings), [findings])
  const sourceCounts = useMemo(() => countBySourceGroup(findings), [findings])
  const groups = useMemo(
    () =>
      groupByCategory(
        filterBySourceGroup(filterBySeverity(findings, severityFilter), sourceFilter),
      ),
    [findings, severityFilter, sourceFilter],
  )
  const total = tracked.length

  // A newly selected finding (e.g. clicked in the editor) must be visible:
  // clear a severity filter that hides it and un-collapse its category; the
  // row itself then scrolls into view (FindingRow).
  const handledSelection = useRef<string | null>(null)
  useEffect(() => {
    if (selectedId === handledSelection.current) return
    handledSelection.current = selectedId
    if (!selectedId) return
    const finding = findings.find((f) => f.id === selectedId)
    if (!finding) return
    if (severityFilter && finding.severity !== severityFilter) {
      setSeverityFilter(null)
    }
    if (sourceFilter && sourceGroupOf(finding.source) !== sourceFilter) {
      setSourceFilter(null)
    }
    setCollapsed((old) => {
      if (!old.has(finding.category)) return old
      const next = new Set(old)
      next.delete(finding.category)
      return next
    })
  }, [selectedId, findings, severityFilter, setSeverityFilter, sourceFilter, setSourceFilter])

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
      <div className="sidebar-top">
        <div className="sidebar-header">
          <h2>
            {m.findings} <span className="count-badge">{total}</span>
            <ScoreBadge open={scoreOpen} onToggle={() => setScoreOpen(!scoreOpen)} />
          </h2>
          <div className="check-status-slot">
            {checkPhase !== 'idle' && <CheckStatus phase={checkPhase} />}
          </div>
        </div>
        {scoreOpen && <ScorePanel />}
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
                    ? m.showAllFindings
                    : m.showOnlySeverity(severity)
                }
                onClick={() =>
                  setSeverityFilter(severityFilter === severity ? null : severity)
                }
              >
                {m.severityCount(severity, counts[severity])}
              </button>
            ))}
          </div>
        )}
        {total > 0 && (
          <div className="source-filter">
            {SOURCE_GROUPS.map((group) => (
              <button
                key={group}
                className={`source-filter-button${
                  sourceFilter === group ? ' active' : ''
                }`}
                title={
                  sourceFilter === group ? m.showAllFindings : m.showOnlySource(group)
                }
                onClick={() =>
                  setSourceFilter(sourceFilter === group ? null : group)
                }
              >
                {m.sourceGroupCount(group, sourceCounts[group])}
              </button>
            ))}
          </div>
        )}
      </div>
      {llmError && <div className="llm-error">{llmError}</div>}
      {total === 0 && checkPhase === 'idle' && (
        <p className="all-clear">{m.allClear}</p>
      )}
      {total > 0 && groups.length === 0 && (severityFilter || sourceFilter) && (
        <p className="all-clear">{m.noFilterMatch}</p>
      )}
      {groups.map((group) => (
        <section key={group.category} className="category-group">
          <button className="category-title" onClick={() => toggle(group.category)}>
            <span className={`category-dot fw-${group.category}`} />
            {m.categoryName(group.category)}
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

function CheckStatus({ phase }: { phase: 'fast' | 'llm' }) {
  const startedAt = useStore((s) => s.llmStartedAt)
  const tokens = useStore((s) => s.llmTokens)
  const m = useMessages()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (phase !== 'llm') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase])

  const label =
    phase === 'llm' && startedAt !== null
      ? llmStatusLabel(now - startedAt, tokens, m)
      : m.fastChecking
  return (
    <span className="check-status">
      <span className="sparkle">✳</span> {label}
    </span>
  )
}

function FindingRow({ finding, selected }: { finding: Finding; selected: boolean }) {
  const m = useMessages()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])
  return (
    <div
      ref={ref}
      className={`finding-row${selected ? ' selected' : ''}`}
      onClick={() => selectFinding(selected ? null : finding.id)}
    >
      <div className="finding-quote">
        “{truncate(finding.span.text, 60)}”
        <span className={`severity severity-${finding.severity}`}>
          {m.severityName(finding.severity)}
        </span>
      </div>
      {selected && (
        <div className="finding-detail">
          <p className="finding-message">{finding.message}</p>
          <p className="finding-source">
            {m.sourceName(finding.source)}
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
  const m = useMessages()
  const extras = useStore((s) => s.extraSuggestions)
  const pending = useStore((s) => s.suggestPendingId === finding.id)
  const anyPending = useStore(
    (s) => s.suggestPendingId !== null || s.rewritePendingId !== null,
  )
  const error = useStore((s) => s.suggestErrors[finding.id])
  const heldBack = useStore((s) => s.suggestHeldBack[finding.id]) ?? NO_HELD_BACK
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
    return <p className="suggest-status">✨ {m.askingLlm}</p>
  }
  if (fetched) {
    return <p className="suggest-status">{m.noReplacement}</p>
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
        ✨ {error ? m.retrySuggestion : m.suggestFix}
      </button>
      {error && <p className="suggest-error">{error}</p>}
      {error && heldBack.length > 0 && (
        <HeldBackList
          candidates={heldBack}
          onApply={(text) => applySuggestion(finding.id, text)}
        />
      )}
    </div>
  )
}

function HeldBackList({
  candidates,
  onApply,
}: {
  candidates: HeldBackSuggestion[]
  onApply: (text: string) => void
}) {
  const m = useMessages()
  const [revealed, setRevealed] = useState(false)
  if (!revealed) {
    return (
      <button
        className="suggestion-button show-held-back"
        onClick={(event) => {
          event.stopPropagation()
          setRevealed(true)
        }}
      >
        {m.showHeldBack(candidates.length)}
      </button>
    )
  }
  return (
    <>
      {candidates.map((candidate) => (
        <div key={candidate.text} className="held-back-option">
          <button
            className="suggestion-button held-back"
            onClick={(event) => {
              event.stopPropagation()
              onApply(candidate.text)
            }}
          >
            {candidate.text}
          </button>
          <p className="held-back-reason">{heldBackReason(candidate, m)}</p>
        </div>
      ))}
    </>
  )
}

function RewriteArea({ finding }: { finding: Finding }) {
  const m = useMessages()
  const rewrite = useStore((s) => s.rewrites[finding.id])
  const pending = useStore((s) => s.rewritePendingId === finding.id)
  const anyPending = useStore(
    (s) => s.suggestPendingId !== null || s.rewritePendingId !== null,
  )
  const error = useStore((s) => s.rewriteErrors[finding.id])
  const heldBack = useStore((s) => s.rewriteHeldBack[finding.id])

  function apply(option: string) {
    if (!rewrite) return
    if (!applyRewrite(finding.id, rewrite.original, option)) {
      const store = useStore.getState()
      store.setRewrite(finding.id, null)
      store.setRewriteError(finding.id, m.sentenceChangedRewriteAgain)
    }
  }

  function applyHeldBack(option: string) {
    if (!heldBack) return
    if (!applyRewrite(finding.id, heldBack.original, option)) {
      const store = useStore.getState()
      store.setRewriteHeldBack(finding.id, null)
      store.setRewriteError(finding.id, m.sentenceChangedRewriteAgain)
    }
  }

  if (pending) {
    return <p className="suggest-status">↻ {m.rewriting}</p>
  }
  if (rewrite && rewrite.options.length > 0) {
    return (
      <div className="rewrites">
        {rewrite.options.map((option) => (
          <button
            key={option}
            className="rewrite-option"
            title={m.applyRewriteTitle}
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
    return <p className="suggest-status">{m.noRewrite}</p>
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
        ↻ {error ? m.retryRewrite : m.rewriteSentence}
      </button>
      {error && <p className="suggest-error">{error}</p>}
      {error && heldBack && heldBack.candidates.length > 0 && (
        <HeldBackList candidates={heldBack.candidates} onApply={applyHeldBack} />
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
