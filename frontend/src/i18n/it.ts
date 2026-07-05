import type { Messages } from './messages'

const sev = { error: 'errore', warning: 'avviso', suggestion: 'suggerimento' }
const sevPlural = { error: 'errori', warning: 'avvisi', suggestion: 'suggerimenti' }
const sevNone = {
  error: 'Nessun errore',
  warning: 'Nessun avviso',
  suggestion: 'Nessun suggerimento',
}
const categories = {
  spelling: 'ortografia',
  grammar: 'grammatica',
  style: 'stile',
  clarity: 'chiarezza',
  vividness: 'vividezza',
  correctness: 'correttezza',
  terminology: 'terminologia',
}
const scopes: Record<string, string> = {
  sentence: 'frase',
  paragraph: 'paragrafo',
  document: 'documento',
}

export const it: Messages = {
  viewEditor: 'Editor',
  viewRules: 'Regole',
  viewTerminology: 'Terminologia',
  language: 'Lingua',
  domain: 'Dominio',
  llm: 'LLM',
  model: 'Modello',
  domainNone: 'nessuno',
  offlineSuffix: ' (offline)',
  autoLabel: 'auto',
  autoTitle: 'Esegui automaticamente il controllo LLM dopo una pausa',
  example: 'Esempio',
  exampleTitle:
    "Sostituisci il contenuto dell'editor con un testo di esempio difettoso per la lingua selezionata",
  check: 'Controlla',
  checking: 'Controllo…',
  basicChecksOnly: (name) => `${name} (solo controlli di base)`,
  uiLocaleTitle: "Lingua dell'interfaccia",

  findings: 'Risultati',
  fastChecking: 'controllo…',
  llmChecking: (elapsed, tokens) =>
    tokens === null
      ? `Controllo LLM… (${elapsed})`
      : `Controllo LLM… (${elapsed} · ↓ ${tokens.toLocaleString('it-IT')} token)`,
  severityName: (s) => sev[s],
  severityCount: (s, n) => (n === 1 ? `1 ${sev[s]}` : `${n} ${sevPlural[s]}`),
  showOnlySeverity: (s) => `Mostra solo ${sevPlural[s]}`,
  showAllFindings: 'Fai clic per mostrare di nuovo tutti i risultati',
  llmCheckFailed: (error) => `Controllo LLM non riuscito: ${error}`,
  allClear: 'Nessun problema trovato. Favoloso!',
  noSeverityMatch: (s) => `${sevNone[s]} tra i risultati attuali.`,
  categoryName: (c) => categories[c],
  sourceName: (source) =>
    source === 'llm' ? 'LLM' : source === 'rule' ? 'regola' : 'terminologia',
  askingLlm: 'interrogo il LLM…',
  noReplacement: 'Il LLM non ha trovato alcuna sostituzione.',
  suggestFix: 'Suggerisci correzione',
  retrySuggestion: 'Riprova suggerimento',
  rewriting: 'riscrittura della frase…',
  noRewrite: 'Il LLM non ha proposto alcuna riscrittura.',
  rewriteSentence: 'Riscrivi frase',
  retryRewrite: 'Riprova riscrittura',
  applyRewriteTitle: 'Sostituisci la frase con questa riscrittura',
  sentenceChangedRewriteAgain: 'La frase è cambiata — riscrivi di nuovo.',
  noReliableSuggestion: (rejected) =>
    `Nessun suggerimento affidabile — ${
      rejected === 1 ? '1 candidato non ha superato' : `${rejected} candidati non hanno superato`
    } i controlli locali.`,

  domains: 'Domini',
  newDomainPlaceholder: 'Nuovo dominio…',
  add: 'Aggiungi',
  deleteDomainTitle: 'Elimina dominio',
  terms: 'Termini',
  searchTermsPlaceholder: 'Cerca termini…',
  allLanguages: 'Tutte le lingue',
  langHeader: 'Lingua',
  preferredHeader: 'Preferito',
  doNotUseHeader: 'Da evitare',
  definitionHeader: 'Definizione',
  sortHeaderTitle: 'Fai clic per ordinare: crescente → decrescente → disattivato',
  languageFilterTitle: 'Mostra solo i termini di una lingua',
  noTermsMatch: 'Nessun termine corrisponde al filtro attuale.',
  preferredPlaceholder: 'termine preferito',
  forbiddenPlaceholder: 'vietati, separati da virgole',
  definitionPlaceholder: 'definizione (facoltativa)',
  deleteTermTitle: 'Elimina termine',
  caseSensitiveTitle: 'Distingui maiuscole e minuscole',

  rulesTitle: 'Regole',
  rulesHint:
    "Controlli deterministici per la lingua selezionata nell'intestazione. Le regole si trovano in {path} e vengono ricaricate al riavvio del server o tramite {endpoint}.",
  couldNotLoadRules: (error) => `Impossibile caricare le regole: ${error}`,
  filesWithErrors: 'File con errori',
  nlpBadgeTitle: 'Richiede il modello spaCy della lingua',
  pattern: 'Pattern',
  detailFlags: (listed, omittedTotal) =>
    omittedTotal === null
      ? `Segnala: ${listed}`
      : `Segnala: ${listed} … (${omittedTotal} in totale)`,
  detailAdjacentRepeated: 'Parole ripetute adiacenti',
  detailTokenPattern: (size) => `Pattern di token spaCy (${size} token)`,
  detailDependencyPattern: (size) => `Pattern di dipendenze spaCy (${size} nodi)`,
  detailOccurrence: (kind, bound, what, pattern, scope) => {
    const quantity = kind === 'more' ? `Più di ${bound}` : `Meno di ${bound}`
    const counted = what === 'tokens' ? 'token' : `corrispondenze di /${pattern}/`
    return `${quantity} ${counted} per ${scopes[scope] ?? scope}`
  },
}
