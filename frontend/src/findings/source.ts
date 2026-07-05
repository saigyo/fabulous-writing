import type { Finding, Source } from '../types'

/**
 * For filtering, findings fall into two groups: deterministic ones (rule
 * engine and terminology) and LLM-generated ones.
 */
export type SourceGroup = 'rule' | 'llm'

export const SOURCE_GROUPS: SourceGroup[] = ['rule', 'llm']

export function sourceGroupOf(source: Source): SourceGroup {
  return source === 'llm' ? 'llm' : 'rule'
}

export function countBySourceGroup(findings: Finding[]): Record<SourceGroup, number> {
  const counts: Record<SourceGroup, number> = { rule: 0, llm: 0 }
  for (const finding of findings) counts[sourceGroupOf(finding.source)] += 1
  return counts
}

export function filterBySourceGroup(
  findings: Finding[],
  group: SourceGroup | null,
): Finding[] {
  return group === null
    ? findings
    : findings.filter((finding) => sourceGroupOf(finding.source) === group)
}
