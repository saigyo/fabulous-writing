# Informal UI Register (B2, #35) — Design

**Item:** [#35](https://github.com/saigyo/fabulous-writing/issues/35),
migrated from the multi-user roadmap backlog. Move the locale catalogs
from the current impersonal register to a friendlier informal one
(*Du*, *tú*, *tu*), applied consistently — the item was deferred because
a half-converted catalog reads worse than either register.

**Scope decisions (settled with Markus, 2026-08-01):**

- **Direct address only.** Strings that instruct or address the user
  become informal second person. Neutral statements of fact, headers,
  labels, and placeholders keep their current wording.
- **Buttons and menu items keep their conventional forms** — German,
  French, and Spanish infinitives, Italian's existing imperatives.
  Register applies to sentences, not labels.
- **en/ja/zh stay byte-identical.** English "you" carries no register;
  Japanese polite です/ます is standard UI register even in informal
  products; Chinese copy contains no second person at all (and has no
  owner review for nuance).

## Current state (audit, 2026-08-01)

Seven catalogs in `frontend/src/i18n/` (~165 keys each, values only —
keys and `messages.ts` types are shared):

- **de** — no Sie-forms anywhere; direct address is impersonal
  ("Klicken, um…", "Bitte erneut versuchen"). `loginTagline` is already
  Du ("Schreib klar.") — never normalize it back.
- **es** — mixed: mostly tú ("Haz clic…", tagline "Escribe claro. Te
  revisamos, no te juzgamos.") with usted outliers ("Vuelva a
  intentarlo.", "Inicie sesión de nuevo…", serverBusy). The
  half-converted state the issue warns about.
- **fr** — impersonal infinitives plus scattered vous-forms (veuillez
  ×2, "Votre session", "vos dernières modifications", "réécrivez",
  "lancez") and a still-impersonal tagline ("Écrire clairement. Être
  relu, pas jugé.").
- **it** — essentially already tu ("Riprova", "Fai clic", "Accedi",
  tagline "Scrivi chiaro.") with one impersonal outlier
  (serverBusy "riprovare tra poco").
- **en/ja/zh** — inert per the scope decisions above.

## The change

Four catalogs change: `de.ts`, `fr.ts`, `es.ts`, `it.ts`. Values only;
no key, type, component, or backend changes. Three catalogs and the
shared types are untouched: `en.ts`, `ja.ts`, `zh.ts`, `messages.ts`.

### Conversion policy (the contract)

For each of the four catalogs, audit **every key** — not only strings a
formal-marker grep can surface: German impersonal constructions like
"Das eigene Passwort wird über das Kontomenü geändert" carry no
searchable marker, and the guard-rules lesson (M2, four instances) is
that fixing only named sites leaves unapplied instances. Classify each
string:

1. **Direct address** (instructs the user, asks them to act, or speaks
   to them: click-hints, retry prompts, "please" sentences, second-person
   possessives) → informal second person:
   - de: Du-imperative, lowercase "du/dein" per current orthography
     ("Klick, um…", "Bitte versuch es gleich noch einmal.").
   - fr: tu ("réessaie", "Reconnecte-toi", "tes dernières
     modifications"); tagline joins de/es in register
     ("Écris clairement. Relu, pas jugé." — exact wording finalized in
     the plan).
   - es: tú ("Vuelve a intentarlo.", "Inicia sesión de nuevo…").
   - it: tu ("riprova tra poco").
2. **Button/menu/toggle labels** → unchanged (conventional infinitive
   or existing imperative forms; register-neutral).
3. **Neutral statements, headers, placeholders, counts** → unchanged.
4. **Already informal** → unchanged, never normalized back (both
   taglines, "Haz clic", "Fai clic", existing Italian imperatives).

### Known conversion set

From the design-phase audit; the plan carries the authoritative per-key
before/after table, and the planning audit may add strings the greps
could not see. The policy above, not this list, is the contract.

- **de** (8): `showAllFindings`, `sortHeaderTitle`, `scoreBadgeTitle`,
  `scoreMechanicsOnly`, `serverBusy`, `sentenceChangedRewriteAgain`,
  `signInFailed`, `sessionExpired`.
- **fr** (10): the vous/veuillez set (`serverBusy`,
  `sentenceChangedRewriteAgain`, `scoreMechanicsOnly`, `scoreOutdated`,
  `signInFailed`, `sessionExpired`) plus the click-hint sentences
  (`showAllFindings`, `sortHeaderTitle`, `scoreBadgeTitle`) and the
  tagline.
- **es** (3): `serverBusy`, `signInFailed`, `sessionExpired`.
- **it** (1): `serverBusy`.

The audit also considered `adminSelfResetHint` (the spec's own
marker-blind example above) and ruled it a neutral mechanism statement,
not direct address — it stays impersonal in all four locales.

## Verification

- Frontend gates: `npm test -- --run` green (existing `i18n.test.ts`
  parity tests included), `npm run build` clean.
- **Register guard test** (new, sibling `register.test.ts`), pinning
  both directions:
  - no formal markers — fr `veuillez`/`\bvous\b`/`\bvotre\b`/`\bvos\b`
    plus the bare 2pl imperatives (`cliquez`, `réessayez`, `lancez`, …),
    de `\bSie\b`/`\bIhnen\b`/`\bIhr(e[mnrs]?)?\b`/`klicken`,
    es `\b[Vv]uelva\b`/`\b[Ii]nicie\b`/`usted`,
    it `\briprovare\b`/`\bLei\b`;
  - the converted informal strings are **present** (a wholesale revert
    to impersonal wording fails even where no formal marker appears).

  Markers are checked against the catalog **source files as raw text**
  (a deliberate deviation from checking evaluated values: it also covers
  template literals inside function values; the cost is that key names
  and comments are scanned too, which is acceptable). Both directions
  are mutation-verified: break the guarded property, watch the test
  fail, restore.
- **Byte-identity gate:** `git diff` for the branch shows zero changes
  to `en.ts`, `ja.ts`, `zh.ts`, `messages.ts`, and any file outside
  `frontend/src/i18n/` + docs.
- No screenshot matrix — copy-only change with no rendering surface at
  risk.

## Review

Markus reviews German natively; fr/es/it ride on the plan review's
language check plus Copilot. ja/zh need no language review because they
do not change.

## Out of scope

- en/ja/zh wording changes of any kind.
- Key renames, type changes, component changes.
- Backend copy (rule messages, LLM prompts, example texts).
- Any register change to button/menu labels.

## Sequencing

After the dark-mode follow-ups (#65/#66, PR #69). Before B9 (#42).
Usual shape: planning PR (this spec + plan, squash-merged), then one
implementation PR closing #35 (`Closes #35.`).
