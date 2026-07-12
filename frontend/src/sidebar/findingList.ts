import type { TrackedFinding } from '../editor/findings'
import type { Finding } from '../types'

export function withCurrentSpans(tracked: TrackedFinding[]): Finding[] {
  return tracked.map((item) => ({
    ...item.finding,
    span: { ...item.finding.span, start: item.from, end: item.to },
  }))
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
