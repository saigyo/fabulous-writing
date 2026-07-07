import type { Messages } from './i18n/messages'
import type { LanguageInfo } from './types'

export function languageLabel(info: LanguageInfo, messages: Messages): string {
  return info.nlp_available ? info.name : messages.basicChecksOnly(info.name)
}

/** Endonym for a language code ("de" → "Deutsch"), the code itself if unknown. */
export function languageName(code: string, languages: LanguageInfo[]): string {
  return languages.find((info) => info.code === code)?.name ?? code
}

// Shown until GET /api/languages responds (or when the backend is unreachable).
export const FALLBACK_LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', nlp_available: true, model: null },
  { code: 'de', name: 'Deutsch', nlp_available: true, model: null },
  { code: 'fr', name: 'Français', nlp_available: true, model: null },
  { code: 'es', name: 'Español', nlp_available: true, model: null },
  { code: 'it', name: 'Italiano', nlp_available: true, model: null },
  { code: 'ja', name: '日本語', nlp_available: true, model: null },
  { code: 'zh', name: '中文', nlp_available: true, model: null },
]
