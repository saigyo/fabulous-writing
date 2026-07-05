import type { Messages } from './messages'

const sev = { error: 'Fehler', warning: 'Warnung', suggestion: 'Vorschlag' }
const sevPlural = { error: 'Fehler', warning: 'Warnungen', suggestion: 'Vorschläge' }
const categories = {
  spelling: 'Rechtschreibung',
  grammar: 'Grammatik',
  style: 'Stil',
  clarity: 'Klarheit',
  vividness: 'Lebendigkeit',
  correctness: 'Korrektheit',
  terminology: 'Terminologie',
}
const scopes: Record<string, string> = {
  sentence: 'Satz',
  paragraph: 'Absatz',
  document: 'Dokument',
}

export const de: Messages = {
  viewEditor: 'Editor',
  viewRules: 'Regeln',
  viewTerminology: 'Terminologie',
  language: 'Sprache',
  domain: 'Domäne',
  llm: 'LLM',
  model: 'Modell',
  domainNone: 'keine',
  offlineSuffix: ' (offline)',
  autoLabel: 'auto',
  autoTitle: 'LLM-Prüfung nach einer Pause automatisch ausführen',
  loadExample: 'Beispieltext laden',
  exampleTitle:
    'Editor-Inhalt durch einen fehlerhaften Beispieltext für die gewählte Sprache ersetzen',
  check: 'Prüfen',
  checking: 'Prüft…',
  basicChecksOnly: (name) => `${name} (nur Basisprüfungen)`,
  uiLocaleTitle: 'Anzeigesprache',

  findings: 'Ergebnisse',
  fastChecking: 'prüft…',
  llmChecking: (elapsed, tokens) =>
    tokens === null
      ? `LLM-Prüfung… (${elapsed})`
      : `LLM-Prüfung… (${elapsed} · ↓ ${tokens.toLocaleString('de-DE')} Tokens)`,
  severityName: (s) => sev[s],
  severityCount: (s, n) => (n === 1 ? `1 ${sev[s]}` : `${n} ${sevPlural[s]}`),
  showOnlySeverity: (s) => `Nur ${sevPlural[s]} anzeigen`,
  showAllFindings: 'Klicken, um wieder alle Ergebnisse anzuzeigen',
  llmCheckFailed: (error) => `LLM-Prüfung fehlgeschlagen: ${error}`,
  allClear: 'Keine Probleme gefunden. Fabelhaft!',
  noSeverityMatch: (s) => `Keine ${sevPlural[s]} unter den aktuellen Ergebnissen.`,
  categoryName: (c) => categories[c],
  sourceName: (source) =>
    source === 'llm' ? 'LLM' : source === 'rule' ? 'Regel' : 'Terminologie',
  askingLlm: 'frage LLM…',
  noReplacement: 'Das LLM hat keinen Ersatz gefunden.',
  suggestFix: 'Korrektur vorschlagen',
  retrySuggestion: 'Vorschlag wiederholen',
  rewriting: 'Satz wird umformuliert…',
  noRewrite: 'Das LLM hat keine Umformulierung angeboten.',
  rewriteSentence: 'Satz umformulieren',
  retryRewrite: 'Umformulierung wiederholen',
  applyRewriteTitle: 'Satz durch diese Umformulierung ersetzen',
  sentenceChangedRewriteAgain: 'Der Satz hat sich geändert — bitte erneut umformulieren.',
  noReliableSuggestion: (rejected) =>
    `Kein verlässlicher Vorschlag — ${
      rejected === 1 ? '1 Kandidat ist' : `${rejected} Kandidaten sind`
    } an lokalen Prüfungen gescheitert.`,

  domains: 'Domänen',
  newDomainPlaceholder: 'Neue Domäne…',
  add: 'Hinzufügen',
  deleteDomainTitle: 'Domäne löschen',
  terms: 'Begriffe',
  searchTermsPlaceholder: 'Begriffe durchsuchen…',
  allLanguages: 'Alle Sprachen',
  langHeader: 'Sprache',
  preferredHeader: 'Bevorzugt',
  doNotUseHeader: 'Nicht verwenden',
  definitionHeader: 'Definition',
  sortHeaderTitle: 'Klicken zum Sortieren: aufsteigend → absteigend → aus',
  languageFilterTitle: 'Nur Begriffe einer Sprache anzeigen',
  noTermsMatch: 'Keine Begriffe entsprechen dem aktuellen Filter.',
  preferredPlaceholder: 'bevorzugter Begriff',
  forbiddenPlaceholder: 'verboten, kommagetrennt',
  definitionPlaceholder: 'Definition (optional)',
  deleteTermTitle: 'Begriff löschen',
  caseSensitiveTitle: 'Groß-/Kleinschreibung beachten',

  rulesTitle: 'Regeln',
  rulesHint:
    'Deterministische Prüfungen für die in der Kopfzeile gewählte Sprache. Regeln liegen in {path} und werden bei Server-Neustart oder über {endpoint} neu geladen.',
  couldNotLoadRules: (error) => `Regeln konnten nicht geladen werden: ${error}`,
  filesWithErrors: 'Dateien mit Fehlern',
  nlpBadgeTitle: 'Benötigt das spaCy-Modell der Sprache',
  pattern: 'Muster',
  detailFlags: (listed, omittedTotal) =>
    omittedTotal === null
      ? `Meldet: ${listed}`
      : `Meldet: ${listed} … (insgesamt ${omittedTotal})`,
  detailAdjacentRepeated: 'Direkt wiederholte Wörter',
  detailTokenPattern: (size) => `spaCy-Token-Muster (${size} Tokens)`,
  detailDependencyPattern: (size) => `spaCy-Dependenz-Muster (${size} Knoten)`,
  detailOccurrence: (kind, bound, what, pattern, scope) => {
    const quantity = kind === 'more' ? `Mehr als ${bound}` : `Weniger als ${bound}`
    const counted = what === 'tokens' ? 'Tokens' : `Treffer von /${pattern}/`
    return `${quantity} ${counted} pro ${scopes[scope] ?? scope}`
  },
}
