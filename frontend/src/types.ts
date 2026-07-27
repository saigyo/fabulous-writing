import type { Scorecard } from './scoring/score'
export type { Scorecard }

export type Category =
  | 'spelling'
  | 'grammar'
  | 'style'
  | 'clarity'
  | 'vividness'
  | 'correctness'
  | 'terminology'

export type Severity = 'error' | 'warning' | 'suggestion'
export type Source = 'llm' | 'rule' | 'terminology'
export type Language = 'en' | 'de' | 'fr' | 'es' | 'it' | 'ja' | 'zh'

export interface LanguageInfo {
  code: Language
  name: string
  nlp_available: boolean
  model: string | null
}

export interface Span {
  start: number
  end: number
  text: string
}

export interface Finding {
  id: string
  category: Category
  severity: Severity
  source: Source
  rule_id: string | null
  message: string
  span: Span
  suggestions: string[]
  advice: string[]
}

export const CATEGORIES: Category[] = [
  'spelling',
  'grammar',
  'style',
  'clarity',
  'vividness',
  'correctness',
  'terminology',
]

export interface Domain {
  id: number
  name: string
  description: string
  is_global: boolean
}

export interface Term {
  id: number
  domain_id: number
  language: Language
  preferred: string
  forbidden_variants: string[]
  definition: string
  case_sensitive: boolean
}

export type CheckType =
  | 'existence'
  | 'substitution'
  | 'occurrence'
  | 'repetition'
  | 'token_pattern'
  | 'dependency'

export interface RuleExamples {
  bad: string[]
  good: string[]
}

export interface RuleInfo {
  rule_id: string
  language: Language
  category: Category
  level: Severity
  extends: CheckType
  message: string
  requires_nlp: boolean
  file: string
  detail: Record<string, unknown>
  pack: string | null
  examples: RuleExamples
}

export interface RuleError {
  file: string
  error: string
}

export interface ProviderInfo {
  name: string
  available: boolean
  models: string[]
  default_model: string
  allowed: boolean
}

export interface LlmSelectionInfo {
  tier: Tier | null
  provider: string | null
  model: string | null
}

export interface EffectiveLlm {
  requested: LlmSelectionInfo
  effective: LlmSelectionInfo
  degraded: boolean
  skipped: string | null
}

export interface CheckStatus {
  check_id: string
  status: string
  findings: Finding[]
  scorecard: Scorecard | null
  effective_llm: EffectiveLlm | null
}

export interface Profile {
  id: number
  language: Language
  name: string
  is_standard: boolean
  categories_off: Category[]
  rule_exceptions: string[]
  packs_on: string[]
  domain_ids: number[]
  llm_provider: string | null
  llm_model: string | null
  llm_tier: Tier | null
  llm_instructions: string
  example_text: string
  is_global: boolean
}

export type Tier = 'quality' | 'balanced' | 'cheap' | 'local'

export const TIERS: Tier[] = ['quality', 'balanced', 'cheap', 'local']

export interface RoutingEntry {
  provider: string
  model: string
  available: boolean
  reason: string | null
  allowed: boolean
}

export interface RoutingTable {
  default_tier: Tier
  tiers: Tier[]
  languages: Partial<Record<Language, Partial<Record<Tier, RoutingEntry>>>>
}

export interface LlmPolicy {
  tiers: Tier[] | null
  providers: string[] | null
  models: Record<string, string[]> | null
}

export interface PolicyPayload {
  llm: LlmPolicy
  features: string[]
}

/** Mirrors backend UsagePayload (app/api/auth.py). */
export interface UsagePayload {
  used_today: number
  limit: number
}

/** Mirrors backend LimitsPayload (app/api/auth.py). */
export interface LimitsPayload {
  max_document_chars: number
  max_llm_document_chars: number
  concurrent_llm_runs: number
}
