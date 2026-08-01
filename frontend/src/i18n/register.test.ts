import { describe, expect, test } from 'vitest'

/**
 * B2 (#35): the de/fr/es/it catalogs address the user informally (Du/tu/tú).
 *
 * Catalog sources are scanned as raw text rather than as evaluated values so
 * template literals inside function values are covered too. The cost is that
 * key names and comments are scanned as well — acceptable, since a formal
 * marker has no business anywhere in these files.
 *
 * FORMAL_MARKERS are the formal-register forms that must never reappear.
 * Case-sensitive where the formal form is capitalized (de Sie/Ihr…, it Lei).
 * Deliberately absent: es "su" (too ambiguous — his/her/its) and de
 * "versuchen" (docRetry/connectionRetry keep the infinitive button label
 * "Erneut versuchen"). de "klicken" IS guarded: bare "klicken" in these
 * catalogs is always a click-hint — direct address per the register
 * policy — never a control description, which names the control's
 * action rather than instructing a click. Compound forms
 * ("Doppelklicken") do not match the \b-bounded marker.
 *
 * REQUIRED pins the converted strings themselves, so a wholesale revert to
 * the impersonal wording fails even where no formal marker would appear.
 */
const sources = import.meta.glob('./{de,es,fr,it}.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const FORMAL_MARKERS: Record<string, RegExp[]> = {
  de: [/\bSie\b/, /\bIhnen\b/, /\bIhr(e[mnrs]?)?\b/, /\bklicken\b/i],
  fr: [
    /veuillez/i,
    /\bvous\b/i,
    /\bvotre\b/i,
    /\bvos\b/i,
    /\b(cliquez|réessayez|réécrivez|lancez|reconnectez|connectez|sélectionnez|saisissez|patientez)\b/i,
  ],
  es: [/\bvuelva\b/i, /\binicie\b/i, /\busted\b/i],
  it: [/\briprovare\b/i, /\bLei\b/],
}

const REQUIRED: Record<string, string[]> = {
  de: [
    'Klicke, um',
    'Klicke zum Sortieren',
    'klicke für Details',
    'versuche es gleich erneut',
    'Bitte versuche es erneut',
    'melde dich erneut an',
    'formuliere ihn erneut um',
    'führe für die vollständige Bewertung eine LLM-Prüfung aus',
  ],
  fr: [
    'Clique pour afficher',
    'Clique pour trier',
    'clique pour les détails',
    'réessaie dans un instant',
    'Réessaie.',
    'réécris-la.',
    'lance une vérification',
    'tes dernières modifications',
    'Ta session a pris fin',
    'Reconnecte-toi',
    'Écris clair.',
  ],
  es: [
    'vuelve a intentarlo en unos instantes',
    'Vuelve a intentarlo.',
    'Inicia sesión de nuevo',
  ],
  it: ['riprova tra poco'],
}

describe('informal register (B2, #35)', () => {
  for (const [locale, markers] of Object.entries(FORMAL_MARKERS)) {
    test(`${locale} catalog has no formal-register markers`, () => {
      const source = sources[`./${locale}.ts`]
      expect(source, `${locale}.ts source loaded`).toBeTypeOf('string')
      for (const marker of markers) {
        expect(marker.exec(source)?.[0] ?? null, `${locale} matches ${marker}`).toBeNull()
      }
    })
  }

  for (const [locale, snippets] of Object.entries(REQUIRED)) {
    test(`${locale} catalog keeps its informal strings`, () => {
      const source = sources[`./${locale}.ts`]
      expect(source, `${locale}.ts source loaded`).toBeTypeOf('string')
      for (const snippet of snippets) {
        expect(source, `${locale} is missing "${snippet}"`).toContain(snippet)
      }
    })
  }
})
