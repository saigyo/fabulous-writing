import type { Messages } from '../i18n/messages'
import type { Category, RuleInfo } from '../types'
import { CATEGORIES } from '../types'

const MAX_LISTED = 6

/** One human-readable line describing what a rule matches. */
export function ruleDetailSummary(rule: RuleInfo, messages: Messages): string {
  const detail = rule.detail
  switch (rule.extends) {
    case 'existence': {
      const items = [
        ...((detail.tokens as string[]) ?? []),
        ...(((detail.raw as string[]) ?? []).map((r) => `/${r}/`)),
      ]
      return items.length > MAX_LISTED
        ? messages.detailFlags(items.slice(0, MAX_LISTED).join(', '), items.length)
        : messages.detailFlags(items.join(', '), null)
    }
    case 'substitution': {
      const swap = (detail.swap as Record<string, string>) ?? {}
      return Object.entries(swap)
        .map(([from, to]) => `${from} → ${to}`)
        .join('; ')
    }
    case 'occurrence':
      return detail.max != null
        ? messages.detailOccurrence(
            'more',
            detail.max as number,
            detail.count === 'tokens' ? 'tokens' : 'matches',
            (detail.token as string) ?? null,
            detail.scope as string,
          )
        : messages.detailOccurrence(
            'fewer',
            detail.min as number,
            detail.count === 'tokens' ? 'tokens' : 'matches',
            (detail.token as string) ?? null,
            detail.scope as string,
          )
    case 'repetition':
      return messages.detailAdjacentRepeated
    case 'token_pattern': {
      const size = ((detail.pattern as unknown[]) ?? []).length
      return messages.detailTokenPattern(size)
    }
    case 'dependency': {
      const size = ((detail.pattern as unknown[]) ?? []).length
      return messages.detailDependencyPattern(size)
    }
    default:
      return ''
  }
}

export interface RuleGroup {
  category: Category
  rules: RuleInfo[]
}

/** Group rules by category in canonical order, rules sorted by id. */
export function groupRulesByCategory(rules: RuleInfo[]): RuleGroup[] {
  return CATEGORIES.map((category) => ({
    category,
    rules: rules
      .filter((rule) => rule.category === category)
      .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
  })).filter((group) => group.rules.length > 0)
}

export interface PackSection {
  pack: string
  rules: RuleInfo[]
}

/** General rules grouped by category; pack rules in one sorted section per pack. */
export function splitByPack(rules: RuleInfo[]): {
  general: RuleGroup[]
  packs: PackSection[]
} {
  const packSlugs = [
    ...new Set(
      rules.map((r) => r.pack).filter((p): p is string => p !== null),
    ),
  ].sort()
  return {
    general: groupRulesByCategory(rules.filter((r) => r.pack === null)),
    packs: packSlugs.map((pack) => ({
      pack,
      rules: rules
        .filter((r) => r.pack === pack)
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    })),
  }
}
