import type { Messages } from './messages'

const sev = { error: 'erreur', warning: 'avertissement', suggestion: 'suggestion' }
const sevPlural = {
  error: 'erreurs',
  warning: 'avertissements',
  suggestion: 'suggestions',
}
const categories = {
  spelling: 'orthographe',
  grammar: 'grammaire',
  style: 'style',
  clarity: 'clarté',
  vividness: 'vivacité',
  correctness: 'exactitude',
  terminology: 'terminologie',
}
const scopes: Record<string, string> = {
  sentence: 'phrase',
  paragraph: 'paragraphe',
  document: 'document',
}

export const fr: Messages = {
  viewEditor: 'Éditeur',
  viewRules: 'Règles',
  viewTerminology: 'Terminologie',
  language: 'Langue',
  domain: 'Domaine',
  llm: 'LLM',
  model: 'Modèle',
  domainNone: 'aucun',
  offlineSuffix: ' (hors ligne)',
  autoLabel: 'auto',
  autoTitle: 'Lancer la vérification LLM automatiquement après une pause',
  loadExample: "Charger un texte d'exemple",
  exampleTitle:
    "Remplacer le contenu de l'éditeur par un texte d'exemple fautif pour la langue sélectionnée",
  check: 'Vérifier',
  checking: 'Vérification…',
  basicChecksOnly: (name) => `${name} (vérifications de base uniquement)`,
  uiLocaleTitle: "Langue d'affichage",
  profile: 'Profil',
  profileModifiedTitle: 'Les réglages diffèrent de ce profil',
  saveToProfile: 'Enregistrer les modifications dans le profil',
  resetToProfile: 'Rétablir les valeurs du profil',
  domainsSelected: (n) => `${n} domaines`,
  viewProfiles: 'Profils',
  tierName: (t) =>
    ({ quality: 'Meilleure qualité', balanced: 'Équilibré', cheap: 'Rapide et économique', local: 'Privé (local)' })[t],
  tierPinnedOption: (model) => `Épinglé : ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Avancé',
  pinnedNote: 'Un modèle épinglé remplace les niveaux',
  clearPin: "Retirer l'épingle",
  llmSkipped: (reason) => `Vérification LLM ignorée : ${reason}`,

  findings: 'Résultats',
  fastChecking: 'vérification…',
  llmChecking: (elapsed, tokens) =>
    tokens === null
      ? `Vérification LLM… (${elapsed})`
      : `Vérification LLM… (${elapsed} · ↓ ${tokens.toLocaleString('fr-FR')} tokens)`,
  severityName: (s) => sev[s],
  severityCount: (s, n) => (n === 1 ? `1 ${sev[s]}` : `${n} ${sevPlural[s]}`),
  showOnlySeverity: (s) => `Afficher uniquement les ${sevPlural[s]}`,
  showAllFindings: 'Cliquer pour afficher à nouveau tous les résultats',
  sourceGroupCount: (g, n) => (g === 'llm' ? `${n} LLM` : `${n} par règles`),
  showOnlySource: (g) =>
    g === 'llm'
      ? 'Afficher uniquement les résultats du LLM'
      : 'Afficher uniquement les résultats basés sur des règles',
  llmCheckFailed: (error) => `Échec de la vérification LLM : ${error}`,
  allClear: 'Aucun problème trouvé. Fabuleux !',
  noFilterMatch: 'Aucun résultat ne correspond au filtre actuel.',
  categoryName: (c) => categories[c],
  sourceName: (source) =>
    source === 'llm' ? 'LLM' : source === 'rule' ? 'règle' : 'terminologie',
  askingLlm: 'demande au LLM…',
  noReplacement: "Le LLM n'a trouvé aucun remplacement.",
  suggestFix: 'Suggérer une correction',
  retrySuggestion: 'Réessayer la suggestion',
  rewriting: 'réécriture de la phrase…',
  noRewrite: "Le LLM n'a proposé aucune réécriture.",
  rewriteSentence: 'Réécrire la phrase',
  retryRewrite: 'Réessayer la réécriture',
  applyRewriteTitle: 'Remplacer la phrase par cette réécriture',
  sentenceChangedRewriteAgain: 'La phrase a changé — réécrivez à nouveau.',
  noReliableSuggestion: (rejected) =>
    `Aucune suggestion fiable — ${
      rejected === 1 ? '1 candidat a' : `${rejected} candidats ont`
    } échoué aux vérifications locales.`,

  domains: 'Domaines',
  newDomainPlaceholder: 'Nouveau domaine…',
  add: 'Ajouter',
  deleteDomainTitle: 'Supprimer le domaine',
  terms: 'Termes',
  searchTermsPlaceholder: 'Rechercher des termes…',
  allLanguages: 'Toutes les langues',
  langHeader: 'Langue',
  preferredHeader: 'Préféré',
  doNotUseHeader: 'À éviter',
  definitionHeader: 'Définition',
  sortHeaderTitle: 'Cliquer pour trier : croissant → décroissant → désactivé',
  languageFilterTitle: "Afficher les termes d'une seule langue",
  noTermsMatch: 'Aucun terme ne correspond au filtre actuel.',
  preferredPlaceholder: 'terme préféré',
  forbiddenPlaceholder: 'interdits, séparés par des virgules',
  definitionPlaceholder: 'définition (facultative)',
  deleteTermTitle: 'Supprimer le terme',
  caseSensitiveTitle: 'Respecter la casse',

  profilesTitle: 'Profils de vérification',
  newProfilePlaceholder: 'Nouveau profil…',
  createProfileTitle: 'Créer à partir des réglages actuels',
  deleteProfileTitle: 'Supprimer le profil',
  resetStandardTitle: 'Rétablir les valeurs par défaut',
  llmInstructionsLabel: 'Instructions LLM supplémentaires',
  llmInstructionsHint:
    'Ajoutées au prompt de vérification intégré (ton, audience, priorités)',
  exampleTextLabel: "Texte d'exemple",
  profileChangeFailed: (error) => `Échec de la modification du profil : ${error}`,

  rulesTitle: 'Règles',
  rulesHint:
    "Vérifications déterministes pour la langue sélectionnée dans l'en-tête. Les règles se trouvent dans {path} et sont rechargées au redémarrage du serveur ou via {endpoint}.",
  couldNotLoadRules: (error) => `Impossible de charger les règles : ${error}`,
  filesWithErrors: 'Fichiers en erreur',
  nlpBadgeTitle: 'Nécessite le modèle spaCy de la langue',
  pattern: 'Motif',
  detailFlags: (listed, omittedTotal) =>
    omittedTotal === null
      ? `Signale : ${listed}`
      : `Signale : ${listed} … (${omittedTotal} au total)`,
  detailAdjacentRepeated: 'Mots répétés consécutifs',
  detailTokenPattern: (size) => `Motif de tokens spaCy (${size} tokens)`,
  detailDependencyPattern: (size) => `Motif de dépendances spaCy (${size} nœuds)`,
  detailOccurrence: (kind, bound, what, pattern, scope) => {
    const quantity = kind === 'more' ? `Plus de ${bound}` : `Moins de ${bound}`
    const counted = what === 'tokens' ? 'tokens' : `correspondances de /${pattern}/`
    return `${quantity} ${counted} par ${scopes[scope] ?? scope}`
  },
  editingRulesFor: (p, l) => `Modification des règles pour : ${p} (${l})`,
  categoryToggleTitle: 'Activer/désactiver toute la catégorie pour le profil',
  ruleToggleTitle: 'Activer/désactiver cette règle pour le profil',
}
