import type { SourceGroup } from '../findings/source'
import type { Category, Severity, Tier } from '../types'

export const LOCALES = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

/** Native display names for the locale switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  ja: '日本語',
  zh: '中文',
}

/**
 * One UI message catalog. Parameterized messages are functions so each
 * language keeps full control over word order, pluralization, and number
 * formatting — there is no template micro-language to fight.
 */
export interface Messages {
  // Header
  viewEditor: string
  viewRules: string
  viewTerminology: string
  language: string
  domain: string
  llm: string
  model: string
  domainNone: string
  offlineSuffix: string
  autoLabel: string
  autoTitle: string
  loadExample: string
  exampleTitle: string
  check: string
  checking: string
  basicChecksOnly: (languageName: string) => string
  uiLocaleTitle: string
  profile: string
  profileModifiedTitle: string
  saveToProfile: string
  resetToProfile: string
  domainsSelected: (n: number) => string
  viewProfiles: string
  tierName: (tier: Tier) => string
  tierPinnedOption: (model: string) => string
  resolvedModel: (model: string, provider: string) => string
  advanced: string
  pinnedNote: string
  clearPin: string
  llmSkipped: (reason: string) => string
  pinThisModel: string

  // Findings sidebar
  findings: string
  fastChecking: string
  llmChecking: (elapsed: string, tokens: number | null) => string
  severityName: (severity: Severity) => string
  severityCount: (severity: Severity, n: number) => string
  showOnlySeverity: (severity: Severity) => string
  showAllFindings: string
  sourceGroupCount: (group: SourceGroup, n: number) => string
  showOnlySource: (group: SourceGroup) => string
  llmCheckFailed: (error: string) => string
  allClear: string
  noFilterMatch: string
  categoryName: (category: Category) => string
  sourceName: (source: 'llm' | 'rule' | 'terminology') => string
  askingLlm: string
  noReplacement: string
  suggestFix: string
  retrySuggestion: string
  rewriting: string
  noRewrite: string
  rewriteSentence: string
  retryRewrite: string
  applyRewriteTitle: string
  sentenceChangedRewriteAgain: string
  noReliableSuggestion: (rejected: number) => string

  // Terminology view
  domains: string
  newDomainPlaceholder: string
  add: string
  deleteDomainTitle: string
  terms: string
  searchTermsPlaceholder: string
  allLanguages: string
  langHeader: string
  preferredHeader: string
  doNotUseHeader: string
  definitionHeader: string
  sortHeaderTitle: string
  languageFilterTitle: string
  noTermsMatch: string
  preferredPlaceholder: string
  forbiddenPlaceholder: string
  definitionPlaceholder: string
  deleteTermTitle: string
  caseSensitiveTitle: string

  // Profiles view
  profilesTitle: string
  newProfilePlaceholder: string
  createProfileTitle: string
  deleteProfileTitle: string
  resetStandardTitle: string
  llmInstructionsLabel: string
  llmInstructionsHint: string
  exampleTextLabel: string
  profileChangeFailed: (error: string) => string

  // Rules view
  rulesTitle: string
  /** May contain the placeholders {path} and {endpoint}. */
  rulesHint: string
  couldNotLoadRules: (error: string) => string
  filesWithErrors: string
  nlpBadgeTitle: string
  pattern: string
  detailFlags: (listed: string, omittedTotal: number | null) => string
  detailAdjacentRepeated: string
  detailTokenPattern: (size: number) => string
  detailDependencyPattern: (size: number) => string
  detailOccurrence: (
    kind: 'more' | 'fewer',
    bound: number,
    what: 'tokens' | 'matches',
    pattern: string | null,
    scope: string,
  ) => string
  editingRulesFor: (profileName: string, languageName: string) => string
  categoryToggleTitle: string
  ruleToggleTitle: string
}
