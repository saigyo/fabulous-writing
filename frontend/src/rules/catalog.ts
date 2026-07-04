import type { Category, RuleInfo } from '../types'
import { CATEGORIES } from '../types'

const MAX_LISTED = 6

/** One human-readable line describing what a rule matches. */
export function ruleDetailSummary(rule: RuleInfo): string {
  const detail = rule.detail
  switch (rule.extends) {
    case 'existence': {
      const items = [
        ...((detail.tokens as string[]) ?? []),
        ...(((detail.raw as string[]) ?? []).map((r) => `/${r}/`)),
      ]
      return items.length > MAX_LISTED
        ? `Flags: ${items.slice(0, MAX_LISTED).join(', ')} … (${items.length} total)`
        : `Flags: ${items.join(', ')}`
    }
    case 'substitution': {
      const swap = (detail.swap as Record<string, string>) ?? {}
      return Object.entries(swap)
        .map(([from, to]) => `${from} → ${to}`)
        .join('; ')
    }
    case 'occurrence': {
      const bound =
        detail.max != null ? `More than ${detail.max}` : `Fewer than ${detail.min}`
      const what =
        detail.count === 'tokens' ? 'tokens' : `matches of /${detail.token}/`
      return `${bound} ${what} per ${detail.scope}`
    }
    case 'repetition':
      return 'Adjacent repeated words'
    case 'token_pattern': {
      const size = ((detail.pattern as unknown[]) ?? []).length
      return `spaCy token pattern (${size} tokens)`
    }
    case 'dependency': {
      const size = ((detail.pattern as unknown[]) ?? []).length
      return `spaCy dependency pattern (${size} nodes)`
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
