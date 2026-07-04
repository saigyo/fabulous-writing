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

export interface ProviderInfo {
  name: string
  available: boolean
  models: string[]
  default_model: string
}

export interface CheckStatus {
  check_id: string
  status: string
  findings: Finding[]
}
