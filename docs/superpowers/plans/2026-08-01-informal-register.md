# Informal UI Register (B2, #35) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the de/fr/es/it UI catalogs to a consistent informal register (Du/tu/tú) for strings that address the user, pinned by a mutation-verified guard test, with en/ja/zh byte-identical.

**Architecture:** Values-only edits to four locale catalogs in `frontend/src/i18n/`, applied from the authoritative conversion table below. A new `register.test.ts` reads the four catalog sources and asserts no formal-register markers remain — it fails RED on today's fr/es/it catalogs and goes GREEN with the conversion. No component, type, key, or backend changes.

**Tech Stack:** React 19 / TypeScript / Vite, vitest (node env), plain `node:fs` in the guard test.

**Spec:** `docs/superpowers/specs/2026-08-01-informal-register-design.md` — its Conversion policy section is the contract; this plan's table is its application to today's catalogs.

## Global Constraints

- `frontend/src/i18n/en.ts`, `ja.ts`, `zh.ts`, and `messages.ts` are **byte-identical** to main — `git diff --name-only main` must never list them.
- Values only: no key renames, no type changes, no component edits, no backend edits.
- Register applies to sentences that address the user. Button/menu/toggle labels and control-description tooltips keep their conventional forms (German/French/Spanish infinitives, Italian imperatives). Neutral statements of fact, headers, placeholders stay unchanged.
- Already-informal strings are never normalized back (de tagline "Schreib klar.", es tagline + "Haz clic…", it "Riprova"/"Fai clic"/"Accedi").
- Every guard test is mutation-verified: reintroduce a formal string, watch the test fail, revert.
- Gates before every commit (frontend touched): `npm test -- --run` green, `npm run build` clean. Backend untouched — no pytest needed.
- Work on branch `informal-register-impl` off `main`. Never push to main; never force-push, amend, or rebase published history.
- Every commit message ends with exactly these two trailer lines:

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
  ```

- All frontend commands run from `frontend/`.

---

### Task 1: Register conversion + guard test

**Files:**
- Create: `frontend/src/i18n/register.test.ts`
- Modify: `frontend/src/i18n/de.ts` (7 values), `frontend/src/i18n/fr.ts` (10 values), `frontend/src/i18n/es.ts` (3 values), `frontend/src/i18n/it.ts` (1 value)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the converted catalogs and the guard test; Task 2 documents the convention this task establishes.

- [ ] **Step 0: Create the implementation branch**

```bash
cd /Users/markus/IdeaProjects/fabulous-writing
git checkout main && git pull
git checkout -b informal-register-impl
```

- [ ] **Step 1: Write the failing guard test**

Create `frontend/src/i18n/register.test.ts` with exactly:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * B2 (#35): the de/fr/es/it catalogs address the user informally (Du/tu/tú).
 * These markers are the formal-register forms that must never reappear.
 * Sources are scanned as text so template literals inside function values
 * are covered too. Case-sensitive where the formal form is capitalized
 * (de Sie/Ihr…, it Lei); es "su" is deliberately absent — too ambiguous
 * (his/her/its) to guard without false positives.
 */
const FORMAL_MARKERS: Record<string, RegExp[]> = {
  de: [/\bSie\b/, /\bIhnen\b/, /\bIhr(e[mnrs]?)?\b/],
  fr: [/veuillez/i, /\bvous\b/i, /\bvotre\b/i, /\bvos\b/i],
  es: [/\bvuelva\b/i, /\binicie\b/i, /\busted\b/i],
  it: [/\briprovare\b/i, /\bLei\b/],
}

describe('informal register (B2, #35)', () => {
  for (const [locale, markers] of Object.entries(FORMAL_MARKERS)) {
    test(`${locale} catalog has no formal-register markers`, () => {
      const path = fileURLToPath(new URL(`./${locale}.ts`, import.meta.url))
      const source = readFileSync(path, 'utf8')
      for (const marker of markers) {
        expect(source, `${locale} catalog matches ${marker}`).not.toMatch(marker)
      }
    })
  }
})
```

- [ ] **Step 2: Run the guard test — verify it fails on today's catalogs**

```bash
cd frontend && npx vitest run src/i18n/register.test.ts
```

Expected: **3 failed, 1 passed** —
- `fr` FAILS (today's catalog contains `veuillez`, `vous`, `Votre`, `vos`),
- `es` FAILS (`Vuelva`, `vuelva`, `Inicie`),
- `it` FAILS (`riprovare`),
- `de` PASSES (German formality today is impersonal, not Sie-marked — its markers are mutation-verified in Step 5).

Any other result: STOP and investigate before touching the catalogs.

- [ ] **Step 3: Apply the conversion table**

Each row is an exact old value → exact new value; edit only the quoted string, preserving quoting style, punctuation (including `—`, `«»`, curly apostrophes), and trailing commas. Everything not listed stays byte-identical.

**`de.ts` (7):**

| Key | Old | New |
|---|---|---|
| `serverBusy` | `'Server ausgelastet — bitte gleich erneut versuchen.'` | `'Server ausgelastet — bitte versuche es gleich erneut.'` |
| `showAllFindings` | `'Klicken, um wieder alle Ergebnisse anzuzeigen'` | `'Klicke, um wieder alle Ergebnisse anzuzeigen'` |
| `sentenceChangedRewriteAgain` | `'Der Satz hat sich geändert — bitte erneut umformulieren.'` | `'Der Satz hat sich geändert — bitte formuliere ihn erneut um.'` |
| `scoreMechanicsOnly` | `'Nur Mechanik — LLM-Prüfung für die vollständige Bewertung ausführen'` | `'Nur Mechanik — führe eine LLM-Prüfung für die vollständige Bewertung aus'` |
| `sortHeaderTitle` | `'Klicken zum Sortieren: aufsteigend → absteigend → aus'` | `'Klicke zum Sortieren: aufsteigend → absteigend → aus'` |
| `signInFailed` | `'Anmeldung fehlgeschlagen. Bitte erneut versuchen.'` | `'Anmeldung fehlgeschlagen. Bitte versuche es erneut.'` |
| `sessionExpired` | `'Die Sitzung ist beendet. Bitte erneut anmelden — ungespeicherte Änderungen bleiben erhalten.'` | `'Die Sitzung ist beendet. Bitte melde dich erneut an — ungespeicherte Änderungen bleiben erhalten.'` |

**`fr.ts` (10):**

| Key | Old | New |
|---|---|---|
| `serverBusy` | `'Serveur occupé — veuillez réessayer dans un instant.'` | `'Serveur occupé — réessaie dans un instant.'` |
| `showAllFindings` | `'Cliquer pour afficher à nouveau tous les résultats'` | `'Clique pour afficher à nouveau tous les résultats'` |
| `sentenceChangedRewriteAgain` | `'La phrase a changé — réécrivez à nouveau.'` | `'La phrase a changé — réécris-la à nouveau.'` |
| `scoreBadgeTitle` | `'Qualité globale — cliquer pour les détails'` | `'Qualité globale — clique pour les détails'` |
| `scoreMechanicsOnly` | `'Mécanique seule — lancez une vérification LLM pour la note complète'` | `'Mécanique seule — lance une vérification LLM pour la note complète'` |
| `scoreOutdated` | `'L’évaluation du métier précède vos dernières modifications'` | `'L’évaluation du métier précède tes dernières modifications'` |
| `sortHeaderTitle` | `'Cliquer pour trier : croissant → décroissant → désactivé'` | `'Clique pour trier : croissant → décroissant → désactivé'` |
| `signInFailed` | `'Échec de la connexion. Veuillez réessayer.'` | `'Échec de la connexion. Réessaie.'` |
| `sessionExpired` | `'Votre session a pris fin. Veuillez vous reconnecter — les modifications non enregistrées ont été conservées.'` | `'Ta session a pris fin. Reconnecte-toi — les modifications non enregistrées ont été conservées.'` |
| `loginTagline` | `'Écrire clairement. Être relu, pas jugé.'` | `'Écris clairement. Relu, pas jugé.'` |

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

Deliberately **unchanged** (the reviewer will check these were not touched): all button/menu labels (`docRetry`/`connectionRetry` "Erneut versuchen"/"Réessayer"/"Reintentar"/"Riprova", `folderDefaultsTakeCurrent`, `saveToProfile`, …), control-description tooltips (`showOnlySeverity`, `showOnlySource`, `autoTitle`, `exampleTitle`, `applyRewriteTitle`, `languageFilterTitle`, `showHeldBack`), neutral statements (`docDeleteConfirm`, `adminSelfResetHint`, es `scoreOutdated` — it has no possessive), and everything already informal (both taglines' Du/tú, es "Haz clic…"/"reescribe"/"ejecuta", it "Fai clic"/"esegui"/"Effettua", fr button infinitives).

- [ ] **Step 4: Run the guard test — verify it passes**

```bash
npx vitest run src/i18n/register.test.ts
```

Expected: **4 passed**.

- [ ] **Step 5: Mutation-verify the de markers**

The de test never failed naturally (Step 2), so prove its markers bite:

1. In `de.ts`, temporarily change `signInFailed` to `'Anmeldung fehlgeschlagen. Bitte versuchen Sie es erneut.'`
2. `npx vitest run src/i18n/register.test.ts` → expected: **de FAILS** (matches `/\bSie\b/`), other three pass.
3. Revert the temporary change (restore `'Anmeldung fehlgeschlagen. Bitte versuche es erneut.'`).
4. `npx vitest run src/i18n/register.test.ts` → expected: **4 passed** again.

Record in the report that the mutation was performed and reverted.

- [ ] **Step 6: Full gates**

```bash
npm test -- --run
npm run build
```

Expected: all vitest files green (including the existing `i18n.test.ts` parity suite), build clean.

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

Du/tu/tú for strings that address the user; buttons, control
descriptions, and neutral statements unchanged; en/ja/zh untouched.
Guard test pins the register (mutation-verified).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 2: Architecture doc + LOGBOOK

**Files:**
- Modify: `docs/frontend-architecture.md` (insert a section immediately before the `## State management` heading, currently line 101)
- Modify: `docs/LOGBOOK.md` (append an entry)

**Interfaces:**
- Consumes: the convention established in Task 1 (guard test path `frontend/src/i18n/register.test.ts`).
- Produces: nothing downstream.

- [ ] **Step 1: Add the register section to the architecture doc**

In `docs/frontend-architecture.md`, immediately **before** the `## State management` heading, insert:

```markdown
## UI copy register (B2)

de/fr/es/it address the user informally (*Du*, *tu*, *tú*) in sentences
that instruct or speak to them (click-hints, retry prompts, session
notices, second-person possessives). Button/menu labels and
control-description tooltips keep their conventional forms
(de/fr/es infinitives, it imperatives); neutral statements of fact stay
impersonal. en carries no register, ja stays polite です/ます, zh has no
second person — all three are untouched by register work.
`i18n/register.test.ts` guards the four converted catalogs against
formal markers (Sie/Ihnen/Ihr…, veuillez/vous/votre/vos,
vuelva/inicie/usted, riprovare/Lei).

```

(Blank line before the existing `## State management` heading preserved.)

- [ ] **Step 2: Append the LOGBOOK entry**

Determine the PR numbers first:

```bash
gh pr list --repo saigyo/fabulous-writing --state all --limit 1 --json number
```

The planning PR is the already-merged "informal register planning" PR (find it with `gh pr list --repo saigyo/fabulous-writing --state merged --limit 5 --json number,title` if unsure). The implementation PR does not exist yet — its number is the latest PR number + 1; sanity-check that assumption against the list output and note it in the entry text as the PR this branch will open.

Append to `docs/LOGBOOK.md` (match the existing entry format; adjust the numbers per the check above):

```markdown
## 2026-08-01 — B2: informal UI register (PRs #<planning>, #<impl>)

de/fr/es/it moved to informal address (Du/tu/tú) for the 21 strings that
speak to the user (7 de, 10 fr, 3 es, 1 it — incl. the fr tagline
"Écris clairement. Relu, pas jugé."); buttons, control descriptions,
and neutral statements untouched; en/ja/zh byte-identical.
`i18n/register.test.ts` guards against formal markers
(mutation-verified: de Sie-string reintroduced, test failed, reverted).
Spec: docs/superpowers/specs/2026-08-01-informal-register-design.md.
```

- [ ] **Step 3: Gates**

Docs-only diff for this task, but the standing gates run before every commit:

```bash
npm test -- --run
npm run build
```

Expected: green / clean.

- [ ] **Step 4: Commit**

```bash
git add docs/frontend-architecture.md docs/LOGBOOK.md
git commit -m "$(cat <<'EOF'
docs(architecture,logbook): record UI copy register convention (B2, #35)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

## Verification summary (for the final review)

- Guard test RED→GREEN across Task 1 Steps 2/4; de markers mutation-verified in Step 5.
- `npm test -- --run` green, `npm run build` clean at every commit.
- `git diff --name-only main` on the finished branch lists exactly: the four catalogs, `register.test.ts`, `docs/frontend-architecture.md`, `docs/LOGBOOK.md` — and none of `en.ts`, `ja.ts`, `zh.ts`, `messages.ts`.
- Implementation PR closes the issue with `Closes #35.`
