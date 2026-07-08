import { useMemo } from 'react'
import { useMessages } from '../i18n'
import {
  craftScore,
  DIMENSIONS,
  mechanicsScore,
  overallScore,
  scoreLevel,
} from '../scoring/score'
import { useStore } from '../state/store'

/** Overall / mechanics / craft for the current document, or null if too short. */
function useScores() {
  const tracked = useStore((s) => s.tracked)
  const docWords = useStore((s) => s.docWords)
  const scorecard = useStore((s) => s.scorecard)
  const mechanics = useMemo(
    () => mechanicsScore(tracked.map((t) => t.finding), docWords),
    [tracked, docWords],
  )
  if (mechanics === null) return null
  const craft = scorecard ? craftScore(scorecard) : null
  return { mechanics, craft, overall: overallScore(mechanics, craft) }
}

export function ScoreBadge({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const stale = useStore((s) => s.scorecardStale)
  const m = useMessages()
  const scores = useScores()

  if (!scores) {
    return (
      <span className="score-badge score-none" title={m.scoreTooShort}>
        –
      </span>
    )
  }
  const { craft, overall } = scores
  const title =
    craft === null ? m.scoreMechanicsOnly : stale ? m.scoreOutdated : m.scoreBadgeTitle
  return (
    <button
      className={`score-badge score-${scoreLevel(overall)}`}
      title={title}
      aria-expanded={open}
      onClick={onToggle}
    >
      {overall}
      {craft === null ? (
        <span className="score-mark">◐</span>
      ) : stale ? (
        <span className="score-mark">⟳</span>
      ) : null}
    </button>
  )
}

export function ScorePanel() {
  const scorecard = useStore((s) => s.scorecard)
  const stale = useStore((s) => s.scorecardStale)
  const m = useMessages()
  const scores = useScores()
  if (!scores) return null
  const { mechanics, craft, overall } = scores

  return (
    <div className="score-panel">
      <div className="score-panel-head">
        <span className={`score-number score-${scoreLevel(overall)}`}>{overall}</span>
        <span className="score-split">
          {m.scoreMechanics} {mechanics}
          {craft !== null && (
            <>
              {' · '}
              {m.scoreCraft} {craft}
            </>
          )}
        </span>
      </div>
      {(craft === null || stale) && (
        <p className="score-freshness">
          {craft === null ? m.scoreMechanicsOnly : m.scoreOutdated}
        </p>
      )}
      {scorecard && (
        <div className="score-dimensions">
          {DIMENSIONS.map((dimension) => (
            <div key={dimension} className="score-dimension">
              <div className="score-dimension-row">
                <span className="score-dimension-name">
                  {m.dimensionName(dimension)}
                </span>
                <span className="score-dimension-bar">
                  {[1, 2, 3, 4, 5].map((step) => (
                    <span
                      key={step}
                      className={`score-seg${
                        scorecard[dimension].score >= step ? ' filled' : ''
                      }`}
                    />
                  ))}
                </span>
              </div>
              {scorecard[dimension].note && (
                <p className="score-dimension-note">{scorecard[dimension].note}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
