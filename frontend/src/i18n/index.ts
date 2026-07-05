import { useStore } from '../state/store'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { it } from './it'
import { ja } from './ja'
import { LOCALES, type Locale, type Messages } from './messages'
import { zh } from './zh'

export { LOCALES, LOCALE_NAMES, type Locale, type Messages } from './messages'

export const catalogs: Record<Locale, Messages> = { en, de, es, fr, it, ja, zh }

/** Pick the first supported locale from a browser preference list (primary
 * subtag match, e.g. de-AT → de); English when nothing matches. */
export function detectLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const primary = preference.toLowerCase().split('-')[0]
    if ((LOCALES as readonly string[]).includes(primary)) return primary as Locale
  }
  return 'en'
}

export function browserLocale(): Locale {
  return detectLocale(navigator.languages ?? [navigator.language])
}

/** The effective UI locale: the user's explicit choice, else the browser's. */
export function useLocale(): Locale {
  const uiLocale = useStore((s) => s.uiLocale)
  return uiLocale ?? browserLocale()
}

export function useMessages(): Messages {
  return catalogs[useLocale()]
}

/** Non-hook variant for code outside React components (event handlers etc.). */
export function currentMessages(): Messages {
  return catalogs[useStore.getState().uiLocale ?? browserLocale()]
}

/**
 * Split a template on {placeholder} markers and substitute the given values —
 * used to weave React nodes (e.g. <code> elements) into translated sentences.
 * Unknown placeholders stay verbatim.
 */
export function interpolate<T>(
  template: string,
  slots: Record<string, T>,
): (string | T)[] {
  return template
    .split(/(\{\w+\})/)
    .filter((part) => part !== '')
    .map((part) => {
      const match = /^\{(\w+)\}$/.exec(part)
      return match && match[1] in slots ? slots[match[1]] : part
    })
}
