import type { SourceGroup } from '../findings/source'
import type { Dimension } from '../scoring/score'
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
  viewAdmin: string
  adminUsersTitle: string
  adminCreate: string
  adminEmail: string
  adminDisplayName: string
  adminPassword: string
  adminTier: string
  adminIsAdmin: string
  adminIsActive: string
  adminResetPassword: string
  adminSelf: string
  adminLoadFailed: string
  adminGrantDisabledHint: string
  adminSelfResetHint: string
  adminChangeFailed: (error: string) => string
  tierName: (tier: Tier) => string
  tierPinnedOption: (model: string) => string
  resolvedModel: (model: string, provider: string) => string
  advanced: string
  pinnedNote: string
  clearPin: string
  llmSkipped: (reason: string) => string
  pinThisModel: string
  advancedTitle: string
  planSuffix: string
  llmDegraded: (effective: string, requested: string) => string
  llmNotIncluded: string
  llmSkippedServer: string
  serverBusy: string
  llmQuotaExhausted: string
  llmDocumentTooLarge: (limit: number) => string
  quotaIndicatorTitle: string
  windowName: (window: string) => string
  charCount: (n: number) => string
  charCountOverLlm: string
  charCountOverDoc: string

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
  showHeldBack: (count: number) => string
  heldBackRules: (rules: string) => string
  heldBackSpelling: (words: string) => string
  scoreBadgeTitle: string
  scoreTooShort: string
  scoreMechanicsOnly: string
  scoreOutdated: string
  scoreMechanics: string
  scoreCraft: string
  dimensionName: (dimension: Dimension) => string

  // Ownership (shared: terminology + profiles)
  globalBadge: string
  globalBadgeTitle: string

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
  editTermTitle: string
  saveEditTitle: string
  cancelEditTitle: string
  renameDomainTitle: string
  changeFailed: (error: string) => string

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
  rulePacks: string
  packName: (slug: string) => string
  packToggleTitle: string
  expandAllTitle: string
  collapseAllTitle: string
  exampleFlagged: string
  exampleNotFlagged: string

  // Document lifecycle
  docNew: string
  docUntitled: string
  docRecovered: (name: string) => string
  docRename: string
  docDelete: string
  docDeleteConfirm: (name: string) => string
  docListError: string
  docRetry: string
  docSidebarShow: string
  docSidebarHide: string
  docMenu: string
  folderNew: string
  folderNamePlaceholder: string
  folderRename: string
  folderDelete: string
  folderDeleteConfirm: (name: string) => string
  folderNewDocument: string
  folderMoveTo: string
  folderNone: string
  folderMenu: string
  folderDefaults: string
  folderDefaultsNone: string
  folderDefaultsTakeCurrent: string
  folderDefaultsAuto: string
  folderDefaultsAutoOn: string
  folderDefaultsAutoOff: string
  folderDefaultsSave: string
  folderDefaultsCancel: string
  folderDefaultsError: string

  // Authentication
  loginTagline: string
  signInEmail: string
  signInPassword: string
  signInSubmit: string
  signInPending: string
  signInInvalid: string
  signInFailed: string
  sessionExpired: string
  accountMenu: string
  accountChangePassword: string
  accountLogOut: string
  passwordCurrent: string
  passwordNew: string
  passwordConfirm: string
  passwordSubmit: string
  passwordCancel: string
  passwordMismatch: string
  passwordTooShort: (min: number) => string
  passwordCurrentWrong: string
  passwordChanged: string
  passwordFailed: string
  connectionFailed: string
  connectionRetry: string
  forgotPassword: string
  resetRequestSent: string
  resetHeading: string
  inviteHeading: string
  resetNewPassword: string
  resetRepeatPassword: string
  resetMismatch: string
  resetSubmit: string
  resetSuccess: string
  resetBackToSignIn: string
  resetLinkInvalid: string
  resetAccountInactive: string
  resetEmailLabel: string
  resetRequestSubmit: string
  backToSignIn: string
  adminPasswordOptionalHint: string
  adminResendInvite: string
  adminResendSent: string
  adminResendAlreadyActive: string
  adminUserInactive: string
  adminInviteSent: string
  adminInviteLinkedNoEmail: string
  pwWeakLength: string
  pwWeakCharacters: string
  pwWeakPwned: string
  pwWeakGeneric: string
  resetUpdateFailedRetry: string

  // Dialog
  dialogCancel: string
  dialogConfirm: string
}
