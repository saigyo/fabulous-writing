import type { Messages } from './messages'

const sev = { error: '错误', warning: '警告', suggestion: '建议' }
const categories = {
  spelling: '拼写',
  grammar: '语法',
  style: '风格',
  clarity: '清晰度',
  vividness: '生动性',
  correctness: '正确性',
  terminology: '术语',
}
const scopes: Record<string, string> = {
  sentence: '句',
  paragraph: '段落',
  document: '文档',
}

export const zh: Messages = {
  viewEditor: '编辑器',
  viewRules: '规则',
  viewTerminology: '术语',
  language: '语言',
  domain: '领域',
  llm: 'LLM',
  model: '模型',
  domainNone: '无',
  offlineSuffix: '(离线)',
  autoLabel: '自动',
  autoTitle: '停顿后自动运行 LLM 检查',
  example: '示例',
  exampleTitle: '用所选语言的含错示例文本替换编辑器内容',
  check: '检查',
  checking: '检查中…',
  basicChecksOnly: (name) => `${name}(仅基础检查)`,
  uiLocaleTitle: '界面语言',

  findings: '检查结果',
  fastChecking: '检查中…',
  llmChecking: (elapsed, tokens) =>
    tokens === null
      ? `LLM 检查中…(${elapsed})`
      : `LLM 检查中…(${elapsed} · ↓ ${tokens.toLocaleString('zh-CN')} 个 token)`,
  severityName: (s) => sev[s],
  severityCount: (s, n) => `${n} 个${sev[s]}`,
  showOnlySeverity: (s) => `仅显示${sev[s]}`,
  showAllFindings: '点击以重新显示所有结果',
  llmCheckFailed: (error) => `LLM 检查失败:${error}`,
  allClear: '未发现问题。妙极了!',
  noSeverityMatch: (s) => `当前结果中没有${sev[s]}。`,
  categoryName: (c) => categories[c],
  sourceName: (source) =>
    source === 'llm' ? 'LLM' : source === 'rule' ? '规则' : '术语',
  askingLlm: '正在询问 LLM…',
  noReplacement: 'LLM 未找到替换。',
  suggestFix: '建议修改',
  retrySuggestion: '重试建议',
  rewriting: '正在重写句子…',
  noRewrite: 'LLM 未提供重写。',
  rewriteSentence: '重写句子',
  retryRewrite: '重试重写',
  applyRewriteTitle: '用此重写替换该句',
  sentenceChangedRewriteAgain: '句子已更改 — 请重新重写。',
  noReliableSuggestion: (rejected) =>
    `没有可靠的建议 — ${rejected} 个候选未通过本地检查。`,

  domains: '领域',
  newDomainPlaceholder: '新领域…',
  add: '添加',
  deleteDomainTitle: '删除领域',
  terms: '术语',
  searchTermsPlaceholder: '搜索术语…',
  allLanguages: '所有语言',
  langHeader: '语言',
  preferredHeader: '推荐',
  doNotUseHeader: '禁用',
  definitionHeader: '定义',
  sortHeaderTitle: '点击排序:升序 → 降序 → 取消',
  languageFilterTitle: '仅显示某一语言的术语',
  noTermsMatch: '没有符合当前筛选条件的术语。',
  preferredPlaceholder: '推荐术语',
  forbiddenPlaceholder: '禁用词,以逗号分隔',
  definitionPlaceholder: '定义(可选)',
  deleteTermTitle: '删除术语',
  caseSensitiveTitle: '区分大小写',

  rulesTitle: '规则',
  rulesHint:
    '针对页眉中所选语言的确定性检查。规则位于 {path},在服务器重启后或通过 {endpoint} 重新加载。',
  couldNotLoadRules: (error) => `无法加载规则:${error}`,
  filesWithErrors: '有错误的文件',
  nlpBadgeTitle: '需要该语言的 spaCy 模型',
  pattern: '模式',
  detailFlags: (listed, omittedTotal) =>
    omittedTotal === null
      ? `标记:${listed}`
      : `标记:${listed} …(共 ${omittedTotal} 项)`,
  detailAdjacentRepeated: '相邻重复的词',
  detailTokenPattern: (size) => `spaCy 词元模式(${size} 个词元)`,
  detailDependencyPattern: (size) => `spaCy 依存模式(${size} 个节点)`,
  detailOccurrence: (kind, bound, what, pattern, scope) => {
    const counted = what === 'tokens' ? '词元' : `/${pattern}/ 的匹配`
    const where = scopes[scope] ?? scope
    return kind === 'more'
      ? `每${where}超过 ${bound} 个${counted}`
      : `每${where}少于 ${bound} 个${counted}`
  },
}
