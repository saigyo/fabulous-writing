# Informal UI Register (B2, #35) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the de/fr/es/it UI catalogs to a consistent informal register (Du/tu/tú) for strings that address the user, pinned by a mutation-verified two-direction guard test, with en/ja/zh byte-identical.

**Architecture:** Values-only edits to four locale catalogs in `frontend/src/i18n/`, applied from the authoritative conversion table below. A new `register.test.ts` scans the four catalog sources as raw text (via Vite's `import.meta.glob` `?raw` — plain `node:fs` fails `tsc -b` because `tsconfig.app.json` types only `vite/client`) and asserts both directions: no formal-register markers remain, and the converted informal strings are present. It fails RED on today's catalogs and goes GREEN with the conversion. No component, type, key, or backend changes.

**Tech Stack:** React 19 / TypeScript / Vite, vitest (node env), `import.meta.glob(…, { query: '?raw' })` for source scanning.

**Spec:** `docs/superpowers/specs/2026-08-01-informal-register-design.md` — its Conversion policy section is the contract; this plan's table is its application to today's catalogs.

## Global Constraints

- `frontend/src/i18n/en.ts`, `ja.ts`, `zh.ts`, and `messages.ts` are **byte-identical** to main — `git diff --name-only main` must never list them.
- Values only: no key renames, no type changes, no component edits, no backend edits.
- Register applies to sentences that address the user. Button/menu/toggle labels and control-description tooltips keep their conventional forms (German/French/Spanish infinitives, Italian imperatives). Neutral statements of fact, headers, placeholders stay unchanged.
- Already-informal strings are never normalized back (de tagline "Schreib klar.", es tagline + "Haz clic…", it "Riprova"/"Fai clic"/"Accedi").
- Every guard test is mutation-verified: break the guarded property, watch the test fail, revert.
- Gates before every commit (frontend touched): `npm run lint` clean, `npm test -- --run` green, `npm run build` clean. Backend untouched — no pytest needed.
- Work on branch `informal-register-impl` off `main`. Never push to main; never force-push, amend, or rebase published history.
- Every commit message ends with the two trailer lines (`Co-Authored-By:` naming the model executing this plan, `Claude-Session:` with the executing session's URL). **The controller supplies the exact current values in each task dispatch — do not copy them from older commits or from planning documents**, which may name a different session or model.
- All frontend commands run from `frontend/`.

---

### Task 1: Register conversion + guard test

**Files:**
- Create: `frontend/src/i18n/register.test.ts`
- Modify: `frontend/src/i18n/de.ts` (8 values), `frontend/src/i18n/fr.ts` (10 values), `frontend/src/i18n/es.ts` (3 values), `frontend/src/i18n/it.ts` (1 value)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the converted catalogs and the guard test; Task 2 documents the convention this task establishes.

- [ ] **Step 0: Create the implementation branch**

Precondition: the planning PR (spec + this plan) is **merged** — verify the plan file exists on main before branching. If it does not, STOP and report.

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git checkout main && git pull
test -f docs/superpowers/plans/2026-08-01-informal-register.md || { echo "STOP: planning PR not merged"; exit 1; }
git checkout -b informal-register-impl
```

- [ ] **Step 1: Write the failing guard test**

Create `frontend/src/i18n/register.test.ts` with exactly:

```ts
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
 * "Erneut versuchen").
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
```

- [ ] **Step 2: Run the guard test — verify it fails on today's catalogs**

```bash
cd frontend && npx vitest run src/i18n/register.test.ts
```

Expected: **8 failed, 0 passed** —
- all four marker tests FAIL: de on `klicken` (three click-hints), fr on `veuillez`/`vous`/`votre`/`vos`, es on `vuelva`/`inicie`, it on `riprovare`;
- all four REQUIRED tests FAIL (the informal strings do not exist yet).

Any other result: STOP and investigate before touching the catalogs.

- [ ] **Step 3: Apply the conversion table**

Each row is an exact old value → exact new value; edit only the quoted string, preserving quoting style, punctuation (including `—`, `«»`, curly apostrophes, French space-colon), and trailing commas. Everything not listed stays byte-identical.

**`de.ts` (8):**

| Key | Old | New |
|---|---|---|
| `serverBusy` | `'Server ausgelastet — bitte gleich erneut versuchen.'` | `'Server ausgelastet — bitte versuche es gleich erneut.'` |
| `showAllFindings` | `'Klicken, um wieder alle Ergebnisse anzuzeigen'` | `'Klicke, um wieder alle Ergebnisse anzuzeigen'` |
| `sentenceChangedRewriteAgain` | `'Der Satz hat sich geändert — bitte erneut umformulieren.'` | `'Der Satz hat sich geändert — bitte formuliere ihn erneut um.'` |
| `scoreBadgeTitle` | `'Gesamtqualität — klicken für Details'` | `'Gesamtqualität — klicke für Details'` |
| `scoreMechanicsOnly` | `'Nur Mechanik — LLM-Prüfung für die vollständige Bewertung ausführen'` | `'Nur Mechanik — führe für die vollständige Bewertung eine LLM-Prüfung aus'` |
| `sortHeaderTitle` | `'Klicken zum Sortieren: aufsteigend → absteigend → aus'` | `'Klicke zum Sortieren: aufsteigend → absteigend → aus'` |
| `signInFailed` | `'Anmeldung fehlgeschlagen. Bitte erneut versuchen.'` | `'Anmeldung fehlgeschlagen. Bitte versuche es erneut.'` |
| `sessionExpired` | `'Die Sitzung ist beendet. Bitte erneut anmelden — ungespeicherte Änderungen bleiben erhalten.'` | `'Die Sitzung ist beendet. Bitte melde dich erneut an — ungespeicherte Änderungen bleiben erhalten.'` |

**`fr.ts` (10):**

| Key | Old | New |
|---|---|---|
| `serverBusy` | `'Serveur occupé — veuillez réessayer dans un instant.'` | `'Serveur occupé — réessaie dans un instant.'` |
| `showAllFindings` | `'Cliquer pour afficher à nouveau tous les résultats'` | `'Clique pour afficher à nouveau tous les résultats'` |
| `sentenceChangedRewriteAgain` | `'La phrase a changé — réécrivez à nouveau.'` | `'La phrase a changé — réécris-la.'` |
| `scoreBadgeTitle` | `'Qualité globale — cliquer pour les détails'` | `'Qualité globale — clique pour les détails'` |
| `scoreMechanicsOnly` | `'Mécanique seule — lancez une vérification LLM pour la note complète'` | `'Mécanique seule — lance une vérification LLM pour la note complète'` |
| `scoreOutdated` | `'L’évaluation du métier précède vos dernières modifications'` | `'L’évaluation du métier précède tes dernières modifications'` |
| `sortHeaderTitle` | `'Cliquer pour trier : croissant → décroissant → désactivé'` | `'Clique pour trier : croissant → décroissant → désactivé'` |
| `signInFailed` | `'Échec de la connexion. Veuillez réessayer.'` | `'Échec de la connexion. Réessaie.'` |
| `sessionExpired` | `'Votre session a pris fin. Veuillez vous reconnecter — les modifications non enregistrées ont été conservées.'` | `'Ta session a pris fin. Reconnecte-toi — les modifications non enregistrées ont été conservées.'` |
| `loginTagline` | `'Écrire clairement. Être relu, pas jugé.'` | `'Écris clair. Relu, pas jugé.'` |

**`es.ts` (3):**

| Key | Old | New |
|---|---|---|
| `serverBusy` | `'Servidor ocupado; vuelva a intentarlo en unos instantes.'` | `'Servidor ocupado; vuelve a intentarlo en unos instantes.'` |
| `signInFailed` | `'No se pudo iniciar sesión. Vuelva a intentarlo.'` | `'No se pudo iniciar sesión. Vuelve a intentarlo.'` |
| `sessionExpired` | `'La sesión ha finalizado. Inicie sesión de nuevo: los cambios sin guardar se han conservado.'` | `'La sesión ha finalizado. Inicia sesión de nuevo: los cambios sin guardar se han conservado.'` |

**`it.ts` (1):**

| Key | Old | New |
|---|---|---|
| `serverBusy` | `'Server occupato: riprovare tra poco.'` | `'Server occupato: riprova tra poco.'` |

Deliberately **unchanged** (the reviewer will check these were not touched): all button/menu labels (`docRetry`/`connectionRetry` "Erneut versuchen"/"Réessayer"/"Reintentar"/"Riprova", `folderDefaultsTakeCurrent`, `saveToProfile`, …), control-description tooltips (`showOnlySeverity`, `showOnlySource`, `autoTitle`, `exampleTitle`, `applyRewriteTitle`, `languageFilterTitle`, `showHeldBack`), neutral statements (`docDeleteConfirm`, es `scoreOutdated` — it has no possessive), and everything already informal (both taglines' Du/tú, es "Haz clic…"/"reescribe"/"ejecuta", it "Fai clic"/"esegui"/"Effettua", fr button infinitives).

**Explicit ruling on `adminSelfResetHint`** (all four locales — de "Das eigene Passwort wird über das Kontomenü geändert."): the spec quotes this string as the motivating example of what a marker grep cannot see, and the audit did consider it. The ruling is that it stays: it is a neutral mechanism statement ("the password is changed via the account menu"), not direct address — converting it would require recasting neutral statements into second person, the depth Markus explicitly declined. This is a decision, not an omission.

- [ ] **Step 4: Run the guard test — verify it passes**

```bash
npx vitest run src/i18n/register.test.ts
```

Expected: **8 passed**.

- [ ] **Step 5: Mutation-verify both guard directions**

The FORMAL_MARKERS side for fr/es/it and de's `klicken` failed naturally in Step 2. Two mutations prove the rest:

1. **de Sie-markers** (never fired naturally): temporarily change `de.ts` `signInFailed` to `'Anmeldung fehlgeschlagen. Bitte versuchen Sie es erneut.'` → run the test → expected: **de marker test FAILS** on `/\bSie\b/` (the de REQUIRED test also fails — `'Bitte versuche es erneut'` is gone). Revert; run again → **8 passed**.
2. **REQUIRED side in isolation** (no marker involved): temporarily change `es.ts` `sessionExpired` to use `'Vuelve a iniciar sesión: …'` instead of `'Inicia sesión de nuevo: …'` → run → expected: **es REQUIRED test FAILS** (missing `'Inicia sesión de nuevo'`) while the es marker test passes. Revert; run again → **8 passed**.

Record in the report that both mutations were performed and reverted.

- [ ] **Step 6: Full gates**

```bash
npm run lint
npm test -- --run
npm run build
```

Expected: lint clean, all vitest files green (including the existing `i18n.test.ts` parity suite), build clean. (`npm run build` runs `tsc -b` — this is where a type error in the new test file would surface.)

- [ ] **Step 7: Byte-identity gate**

```bash
git diff --name-only main
git status --short
```

Expected: `git diff --name-only main` lists exactly the four modified catalogs —

```
frontend/src/i18n/de.ts
frontend/src/i18n/es.ts
frontend/src/i18n/fr.ts
frontend/src/i18n/it.ts
```

— and `git status --short` additionally shows only the untracked `frontend/src/i18n/register.test.ts` (`??`). `en.ts`, `ja.ts`, `zh.ts`, `messages.ts` must appear in **neither** listing. Any extra file: STOP, investigate.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/i18n/register.test.ts frontend/src/i18n/de.ts frontend/src/i18n/fr.ts frontend/src/i18n/es.ts frontend/src/i18n/it.ts
git commit -m "$(cat <<'EOF'
feat(i18n): informal register for de/fr/es/it direct address (B2, #35)

Du/tu/tú for the 22 strings that address the user; buttons, control
descriptions, and neutral statements unchanged; en/ja/zh untouched.
Guard test pins both directions (mutation-verified).

<TRAILERS-FROM-DISPATCH>
EOF
)"
```

(`<TRAILERS-FROM-DISPATCH>`: the two trailer lines with the current values the controller supplied in the dispatch.)

---

### Task 2: Architecture doc

**Files:**
- Modify: `docs/frontend-architecture.md` — append to the existing `## Internationalization` section, immediately before the next `##` heading.

**Interfaces:**
- Consumes: the convention established in Task 1 (guard test path `frontend/src/i18n/register.test.ts`).
- Produces: nothing downstream.

- [ ] **Step 1: Append the register subsection**

At the end of the `## Internationalization` section of `docs/frontend-architecture.md` (after its last paragraph, before the next `##` heading), append:

```markdown
### UI copy register (B2)

de/fr/es/it address the user informally (*Du*, *tu*, *tú*) in sentences
that instruct or speak to them: click-hints, retry prompts, session
notices, second-person possessives. Button/menu labels and
control-description tooltips keep their conventional forms (de/fr/es
infinitives, it imperatives), and neutral statements of fact stay
impersonal — deliberately including the `adminSelfResetHint` family. en
carries no register, ja stays polite です/ます, zh has no second person:
all three are untouched by register work. `i18n/register.test.ts` pins
both directions — formal markers must not reappear (de Sie/Ihnen/Ihr…/
klicken; fr veuillez/vous/votre/vos and -ez imperatives; es
vuelva/inicie/usted; it riprovare/Lei) and the converted informal
strings must stay present.
```

- [ ] **Step 2: Gates**

Docs-only diff for this task, but the standing gates run before every commit:

```bash
npm run lint
npm test -- --run
npm run build
```

Expected: clean / green / clean.

- [ ] **Step 3: Commit**

```bash
git add docs/frontend-architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): record UI copy register convention (B2, #35)

<TRAILERS-FROM-DISPATCH>
EOF
)"
```

---

### Post-PR step (controller, not a subagent task): LOGBOOK

The LOGBOOK convention references PR numbers, and the implementation PR number does not exist until `gh pr create` runs — so this step happens **after** the final whole-branch review, when the controller pushes the branch and opens the PR (body ends with the repo's PR trailer; closing keyword `Closes #35.`). Then, with the real numbers in hand, append to `docs/LOGBOOK.md` on the PR branch (match the existing entry format):

```markdown
## 2026-08-01 — B2: informal UI register (PRs #<planning>, #<impl>)

de/fr/es/it moved to informal address (Du/tu/tú) for the 22 strings that
speak to the user (8 de, 10 fr, 3 es, 1 it — incl. the fr tagline
"Écris clair. Relu, pas jugé."); buttons, control descriptions, and
neutral statements untouched (adminSelfResetHint stays impersonal by
explicit ruling); en/ja/zh byte-identical. `i18n/register.test.ts` pins
the register in both directions (formal markers absent + informal
strings present; both sides mutation-verified).
Spec: docs/superpowers/specs/2026-08-01-informal-register-design.md.
```

Commit with the standard trailers and push to the open PR branch. The date in the heading is the date the entry is written — run `date` first.

---

## Verification summary (for the final review)

- Guard test RED→GREEN across Task 1 Steps 2/4 (8 failed → 8 passed); de Sie-markers and the REQUIRED direction mutation-verified in Step 5.
- `npm run lint` clean, `npm test -- --run` green, `npm run build` clean at every commit.
- `git diff --name-only main` on the finished branch lists exactly: the four catalogs, `register.test.ts`, `docs/frontend-architecture.md` — and none of `en.ts`, `ja.ts`, `zh.ts`, `messages.ts`. (`docs/LOGBOOK.md` joins after the post-PR step.)
- The PR body surfaces the full German diff prominently for Markus's native review (spec §Review).
- Implementation PR closes the issue with `Closes #35.`
