import { useStore } from '../state/store'
import { LOCALES, LOCALE_NAMES, useLocale, useMessages, type Locale } from './index'

export function LocaleSwitcher() {
  const locale = useLocale()
  const setUiLocale = useStore((s) => s.setUiLocale)
  const m = useMessages()
  return (
    <label className="locale-switch" title={m.uiLocaleTitle}>
      <span aria-hidden="true">🌐</span>
      <span className="locale-caret" aria-hidden="true">
        ▾
      </span>
      <select
        value={locale}
        aria-label={m.uiLocaleTitle}
        onChange={(e) => setUiLocale(e.target.value as Locale)}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  )
}
