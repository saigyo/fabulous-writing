import type { Messages } from './messages'

const sev = { error: 'エラー', warning: '警告', suggestion: '提案' }
const categories = {
  spelling: 'スペル',
  grammar: '文法',
  style: '文体',
  clarity: '明瞭さ',
  vividness: '表現力',
  correctness: '正確さ',
  terminology: '用語',
}
const scopes: Record<string, string> = {
  sentence: '文',
  paragraph: '段落',
  document: '文書',
}

export const ja: Messages = {
  viewEditor: 'エディター',
  viewRules: 'ルール',
  viewTerminology: '用語集',
  language: '言語',
  domain: 'ドメイン',
  llm: 'LLM',
  model: 'モデル',
  domainNone: 'なし',
  offlineSuffix: '(オフライン)',
  autoLabel: '自動',
  autoTitle: '入力が止まったら LLM チェックを自動実行',
  loadExample: '例文を読み込む',
  exampleTitle: '選択中の言語の誤りを含む例文でエディターの内容を置き換える',
  check: 'チェック',
  checking: 'チェック中…',
  basicChecksOnly: (name) => `${name}(基本チェックのみ)`,
  uiLocaleTitle: '表示言語',
  profile: 'プロファイル',
  profileModifiedTitle: '設定がプロファイルと異なります',
  saveToProfile: '変更をプロファイルに保存',
  resetToProfile: 'プロファイルの値に戻す',
  domainsSelected: (n) => `${n} 個のドメイン`,
  viewProfiles: 'プロファイル',

  findings: '検出結果',
  fastChecking: 'チェック中…',
  llmChecking: (elapsed, tokens) =>
    tokens === null
      ? `LLM チェック中…(${elapsed})`
      : `LLM チェック中…(${elapsed} · ↓ ${tokens.toLocaleString('ja-JP')} トークン)`,
  severityName: (s) => sev[s],
  severityCount: (s, n) => `${sev[s]} ${n}件`,
  showOnlySeverity: (s) => `${sev[s]}のみ表示`,
  showAllFindings: 'クリックですべての検出結果を表示',
  sourceGroupCount: (g, n) => (g === 'llm' ? `LLM ${n}件` : `ルール ${n}件`),
  showOnlySource: (g) =>
    g === 'llm' ? 'LLMの検出結果のみ表示' : 'ルールベースの検出結果のみ表示',
  llmCheckFailed: (error) => `LLM チェックに失敗しました: ${error}`,
  allClear: '問題は見つかりませんでした。お見事!',
  noFilterMatch: '現在のフィルターに一致する検出結果はありません。',
  categoryName: (c) => categories[c],
  sourceName: (source) =>
    source === 'llm' ? 'LLM' : source === 'rule' ? 'ルール' : '用語',
  askingLlm: 'LLM に問い合わせ中…',
  noReplacement: 'LLM は置き換えを見つけられませんでした。',
  suggestFix: '修正を提案',
  retrySuggestion: '提案を再試行',
  rewriting: '文を書き直し中…',
  noRewrite: 'LLM は書き直しを提案しませんでした。',
  rewriteSentence: '文を書き直す',
  retryRewrite: '書き直しを再試行',
  applyRewriteTitle: 'この書き直しで文を置き換える',
  sentenceChangedRewriteAgain: '文が変更されました — もう一度書き直してください。',
  noReliableSuggestion: (rejected) =>
    `信頼できる提案はありません — ${rejected}件の候補がローカルチェックで却下されました。`,

  domains: 'ドメイン',
  newDomainPlaceholder: '新しいドメイン…',
  add: '追加',
  deleteDomainTitle: 'ドメインを削除',
  terms: '用語',
  searchTermsPlaceholder: '用語を検索…',
  allLanguages: 'すべての言語',
  langHeader: '言語',
  preferredHeader: '推奨',
  doNotUseHeader: '使用禁止',
  definitionHeader: '定義',
  sortHeaderTitle: 'クリックで並べ替え: 昇順 → 降順 → 解除',
  languageFilterTitle: '1つの言語の用語のみ表示',
  noTermsMatch: '現在のフィルターに一致する用語はありません。',
  preferredPlaceholder: '推奨する用語',
  forbiddenPlaceholder: '禁止語をカンマ区切りで',
  definitionPlaceholder: '定義(任意)',
  deleteTermTitle: '用語を削除',
  caseSensitiveTitle: '大文字と小文字を区別',

  profilesTitle: 'チェックプロファイル',
  newProfilePlaceholder: '新しいプロファイル…',
  createProfileTitle: '現在の設定から作成',
  deleteProfileTitle: 'プロファイルを削除',
  resetStandardTitle: '既定値にリセット',
  llmInstructionsLabel: 'LLM への追加指示',
  llmInstructionsHint: '組み込みのチェックプロンプトに追加されます(トーン・読者・重点)',
  exampleTextLabel: 'サンプルテキスト',
  profileChangeFailed: (error) => `プロファイルの変更に失敗しました: ${error}`,

  rulesTitle: 'ルール',
  rulesHint:
    'ヘッダーで選択した言語の決定的チェック。ルールは {path} にあり、サーバー再起動または {endpoint} で再読み込みされます。',
  couldNotLoadRules: (error) => `ルールを読み込めませんでした: ${error}`,
  filesWithErrors: 'エラーのあるファイル',
  nlpBadgeTitle: 'その言語の spaCy モデルが必要',
  pattern: 'パターン',
  detailFlags: (listed, omittedTotal) =>
    omittedTotal === null ? `対象: ${listed}` : `対象: ${listed} …(全${omittedTotal}件)`,
  detailAdjacentRepeated: '隣接する重複語',
  detailTokenPattern: (size) => `spaCy トークンパターン(${size} トークン)`,
  detailDependencyPattern: (size) => `spaCy 依存構造パターン(${size} ノード)`,
  detailOccurrence: (kind, bound, what, pattern, scope) => {
    const counted = what === 'tokens' ? 'トークン' : `/${pattern}/ の一致`
    const where = scopes[scope] ?? scope
    return kind === 'more'
      ? `1${where}あたり${counted}が${bound}を超える`
      : `1${where}あたり${counted}が${bound}未満`
  },
  editingRulesFor: (p, l) => `ルールを編集中:${p}(${l})`,
  categoryToggleTitle: 'このカテゴリー全体を切り替え',
  ruleToggleTitle: 'このルールを切り替え',
}
