import type { Finding, Severity } from '../types'

export const SEVERITIES: Severity[] = ['error', 'warning', 'suggestion']

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, suggestion: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

export function filterBySeverity(
  findings: Finding[],
  severity: Severity | null,
): Finding[] {
  return severity === null
    ? findings
    : findings.filter((finding) => finding.severity === severity)
}
