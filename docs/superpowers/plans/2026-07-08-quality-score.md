# Text Quality Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An overall 0–100 quality score (mechanics from live findings + a six-dimension LLM "craft" scorecard) shown as a live badge and expandable panel in the editor sidebar.

**Architecture:** Approach B from the spec (`docs/superpowers/specs/2026-07-08-quality-score-design.md`): the backend's LLM check additionally returns a scorecard (same call, no extra cost), validated strictly and streamed via a new SSE event; the frontend computes all scores in a pure, framework-free TypeScript module whose formulas are normatively documented in `docs/scoring.md` (shared worked examples = golden tests).

**Tech Stack:** FastAPI/pydantic (backend), TypeScript + vitest (scoring module), React/zustand (UI), playwright-core headless Chrome (e2e).

## Global Constraints

- Commits go directly on `main`, pushed to origin; messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Backend commands run from `backend/` via `uv run …`; frontend from `frontend/` via `npm …`.
- Never touch `backend/data/fabulous.db` (owner's live DB) — tests use tmp_path DBs.
- The scoring module (`frontend/src/scoring/score.ts`) must not import from React, zustand, CodeMirror, or any app module — pure TS only.
- All new UI strings go through i18n: add each key to `frontend/src/i18n/messages.ts` AND all 7 locale files (en, de, es, fr, it, ja, zh) — the key-parity test fails otherwise.
- Scoring v1 constants (do not change): severity points error=5 / warning=2 / suggestion=0.5; density scale 15; minimum 40 words; CJK char = 0.5 words; weights 0.5/0.5; rounding = half-up; color thresholds <50 low, <80 mid, ≥80 high.

---

### Task 1: Normative scoring documentation

**Files:**
- Create: `docs/scoring.md`

**Interfaces:**
- Produces: the worked examples (A–E below) that Task 2's golden tests assert verbatim.

- [ ] **Step 1: Write `docs/scoring.md`**

````markdown
# Scoring — normative specification (v1)

This document is the **authoritative definition** of the Fabulous Writing quality
score. Any client (the bundled web frontend, future native or CLI clients) must
implement exactly these formulas. The reference implementation with golden tests
is `frontend/src/scoring/score.ts`; its tests assert the worked examples below,
so this document and the implementation cannot drift apart silently.

**Version: 1.** Any change to a formula, constant, or rule below bumps this
version.

## Overview

The overall score (0–100) combines two components:

- **Mechanics** — deterministic, computed by the client from the current list
  of findings (which resolve live as the writer fixes issues).
- **Craft** — from the LLM scorecard: six holistic dimensions rated 1–5,
  delivered by the check API (SSE event `scorecard` / nullable `scorecard`
  field on `GET /api/checks/{id}`).

```
overall = round(0.5 · mechanics + 0.5 · craft)
```

With no scorecard available, `overall = mechanics`, and the UI must label the
score as *mechanics only*.

**Rounding** is half-up everywhere (round(62.5) = 63, round(64.4) = 64).
Beware: Python 3's built-in `round()` is banker's rounding — use
`math.floor(x + 0.5)` when reimplementing in Python.

## Word count

`words(text)` is language-aware so scores are comparable between
space-delimited and CJK languages:

1. Every character in the Unicode scripts **Han, Hiragana, or Katakana**
   counts as **0.5 words** and is removed from the text (replaced by a space)
   before step 2.
2. The remaining text contributes one word per **maximal run of Unicode
   letters and digits** (`[\p{L}\p{N}]+`).

Consequences (intentional, keep them): `don't` = 2 words, `state-of-the-art`
= 4 words, `你好世界` = 2 words, `Hello, world! 你好世界` = 4 words.

## Mechanics (0–100)

Computed from the current findings (severity is the only input per finding):

```
points    = 5 · #errors + 2 · #warnings + 0.5 · #suggestions
density   = points / words × 100
mechanics = round(100 · e^(−density / 15))
```

**Minimum length:** if `words < 40`, no score exists at all (not 100, not 0 —
the UI shows a "too short to score" state and the composite is not computed).

## Craft (0–100)

The scorecard has exactly six dimensions, each an integer score 1–5 plus a
one-sentence note (informational, not part of the formula):

| Dimension | Judges |
|---|---|
| `consistency` | uniform terminology, register, and stylistic choices throughout |
| `flow` | transitions, rhythm, sentence-length variety |
| `clarity` | document-level understandability |
| `vividness` | engagement, concreteness, imagery |
| `tone` | tone & formality fit for the profile's expectations and evident genre |
| `structure` | organization, paragraphing, logical order for the domain |

```
craft = round((mean(six scores) − 1) / 4 × 100)
```

All 1s → 0, all 3s → 50, all 5s → 100.

**Validity gate:** a scorecard missing any of the six dimensions or containing
a score outside 1–5 is invalid **as a whole** and must be treated as absent.
(The backend already enforces this; clients receive only valid scorecards.)

**Staleness:** the craft component keeps the last received scorecard until the
next one arrives. Once the document is edited after a scorecard arrived, the
UI must mark the score as outdated; the number itself is not decayed.

## Display thresholds

`< 50` low (red) · `50–79` mid (amber) · `≥ 80` high (green).

## Worked examples (golden)

- **A (mechanics):** 200 words, 1 error + 4 warnings + 0 suggestions →
  points 13 → density 6.5 → `round(100·e^(−6.5/15))` = round(64.857…) = **65**.
- **B (mechanics):** 200 words, 1 suggestion → points 0.5 → density 0.25 →
  round(98.347…) = **98**.
- **C (craft):** scores consistency 4, flow 3, clarity 4, vividness 2, tone 5,
  structure 3 → mean 3.5 → (3.5−1)/4×100 = 62.5 → **63** (half-up).
- **D (overall):** mechanics 65, craft 63 → round(0.5·65 + 0.5·63) = **64**.
- **E (word count):** `"Hello, world! 你好世界"` → 2 runs + 4 CJK chars × 0.5
  = **4**. `"don't stop"` → **3**.
- **F (too short):** a 39-word text has no score regardless of findings.
````

- [ ] **Step 2: Commit**

```bash
git add docs/scoring.md
git commit -m "docs: normative specification of scoring v1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure scoring module (TDD)

**Files:**
- Create: `frontend/src/scoring/score.ts`
- Test: `frontend/src/scoring/score.test.ts`

**Interfaces:**
- Produces (used by Tasks 3, 6):
  - `type ScoreSeverity = 'error' | 'warning' | 'suggestion'`
  - `interface ScoreDimension { score: number; note: string }`
  - `const DIMENSIONS = ['consistency','flow','clarity','vividness','tone','structure'] as const`
  - `type Dimension = (typeof DIMENSIONS)[number]`
  - `type Scorecard = Record<Dimension, ScoreDimension>`
  - `wordCount(text: string): number`
  - `mechanicsScore(findings: readonly {severity: ScoreSeverity}[], words: number): number | null`
  - `craftScore(scorecard: Scorecard): number`
  - `overallScore(mechanics: number, craft: number | null): number`
  - `scoreLevel(score: number): 'low' | 'mid' | 'high'`
  - constants `SCORING_VERSION`, `MIN_WORDS`

- [ ] **Step 1: Write the failing tests** (`frontend/src/scoring/score.test.ts`)

```typescript
import { describe, expect, it } from 'vitest'
import {
  craftScore,
  mechanicsScore,
  overallScore,
  scoreLevel,
  wordCount,
  type Scorecard,
  type ScoreSeverity,
} from './score'

function findings(errors: number, warnings: number, suggestions: number) {
  const make = (severity: ScoreSeverity, n: number) =>
    Array.from({ length: n }, () => ({ severity }))
  return [
    ...make('error', errors),
    ...make('warning', warnings),
    ...make('suggestion', suggestions),
  ]
}

function scorecard(scores: [number, number, number, number, number, number]): Scorecard {
  const [consistency, flow, clarity, vividness, tone, structure] = scores
  const dim = (score: number) => ({ score, note: '' })
  return {
    consistency: dim(consistency),
    flow: dim(flow),
    clarity: dim(clarity),
    vividness: dim(vividness),
    tone: dim(tone),
    structure: dim(structure),
  }
}

// Golden tests: the worked examples from docs/scoring.md, asserted verbatim.
describe('docs/scoring.md worked examples', () => {
  it('A: 200 words, 1 error + 4 warnings → 65', () => {
    expect(mechanicsScore(findings(1, 4, 0), 200)).toBe(65)
  })
  it('B: 200 words, 1 suggestion → 98', () => {
    expect(mechanicsScore(findings(0, 0, 1), 200)).toBe(98)
  })
  it('C: craft of [4,3,4,2,5,3] → 63 (half-up)', () => {
    expect(craftScore(scorecard([4, 3, 4, 2, 5, 3]))).toBe(63)
  })
  it('D: overall of mechanics 65 + craft 63 → 64', () => {
    expect(overallScore(65, 63)).toBe(64)
  })
  it('E: word counting', () => {
    expect(wordCount('Hello, world! 你好世界')).toBe(4)
    expect(wordCount("don't stop")).toBe(3)
  })
  it('F: under 40 words there is no score', () => {
    expect(mechanicsScore([], 39)).toBeNull()
    expect(mechanicsScore(findings(3, 0, 0), 39.5)).toBeNull()
  })
})

describe('wordCount', () => {
  it('counts letter/digit runs', () => {
    expect(wordCount('one two three')).toBe(3)
    expect(wordCount('state-of-the-art')).toBe(4)
    expect(wordCount('version 2 shipped')).toBe(3)
  })
  it('counts CJK characters as half words', () => {
    expect(wordCount('你好世界')).toBe(2)
    expect(wordCount('これはテストです')).toBe(4)
  })
  it('is 0 for empty and whitespace-only text', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('  \n\t ')).toBe(0)
  })
})

describe('mechanicsScore', () => {
  it('is 100 for a clean text', () => {
    expect(mechanicsScore([], 200)).toBe(100)
  })
  it('approaches but never goes below 0 under many errors', () => {
    const score = mechanicsScore(findings(100, 0, 0), 40)
    expect(score).toBe(0) // e^(-1250/15) rounds to 0
  })
  it('scores exactly 40 words (boundary is inclusive)', () => {
    expect(mechanicsScore([], 40)).toBe(100)
  })
})

describe('craftScore', () => {
  it('maps all 1s to 0, all 3s to 50, all 5s to 100', () => {
    expect(craftScore(scorecard([1, 1, 1, 1, 1, 1]))).toBe(0)
    expect(craftScore(scorecard([3, 3, 3, 3, 3, 3]))).toBe(50)
    expect(craftScore(scorecard([5, 5, 5, 5, 5, 5]))).toBe(100)
  })
})

describe('overallScore', () => {
  it('returns mechanics unchanged when craft is null', () => {
    expect(overallScore(87, null)).toBe(87)
  })
})

describe('scoreLevel', () => {
  it('maps the documented thresholds', () => {
    expect(scoreLevel(0)).toBe('low')
    expect(scoreLevel(49)).toBe('low')
    expect(scoreLevel(50)).toBe('mid')
    expect(scoreLevel(79)).toBe('mid')
    expect(scoreLevel(80)).toBe('high')
    expect(scoreLevel(100)).toBe('high')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `frontend/`): `npx vitest run src/scoring/score.test.ts`
Expected: FAIL — cannot resolve `./score`.

- [ ] **Step 3: Implement `frontend/src/scoring/score.ts`**

```typescript
/**
 * Fabulous Writing quality score — reference implementation of scoring v1.
 *
 * NORMATIVE SPEC: docs/scoring.md. The golden tests in score.test.ts assert
 * that document's worked examples verbatim; change formula and doc together
 * (and bump SCORING_VERSION).
 *
 * This module is deliberately framework-free (no React/zustand/CodeMirror/app
 * imports) so any TypeScript client can reuse it unchanged.
 */

export const SCORING_VERSION = 1

export type ScoreSeverity = 'error' | 'warning' | 'suggestion'

export interface ScoreDimension {
  score: number
  note: string
}

export const DIMENSIONS = [
  'consistency',
  'flow',
  'clarity',
  'vividness',
  'tone',
  'structure',
] as const

export type Dimension = (typeof DIMENSIONS)[number]

export type Scorecard = Record<Dimension, ScoreDimension>

export const SEVERITY_POINTS: Record<ScoreSeverity, number> = {
  error: 5,
  warning: 2,
  suggestion: 0.5,
}
export const DENSITY_SCALE = 15
export const MIN_WORDS = 40
export const MECHANICS_WEIGHT = 0.5

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu
const WORD_RUN = /[\p{L}\p{N}]+/gu

/** Language-aware word count: letter/digit runs, CJK chars as half words. */
export function wordCount(text: string): number {
  const cjkChars = (text.match(CJK) ?? []).length
  const runs = text.replace(CJK, ' ').match(WORD_RUN) ?? []
  return runs.length + cjkChars * 0.5
}

/**
 * Mechanics component from the current findings; null below the minimum
 * text length (no score exists at all, see docs/scoring.md).
 */
export function mechanicsScore(
  findings: readonly { severity: ScoreSeverity }[],
  words: number,
): number | null {
  if (words < MIN_WORDS) return null
  const points = findings.reduce((sum, f) => sum + SEVERITY_POINTS[f.severity], 0)
  const density = (points / words) * 100
  return Math.round(100 * Math.exp(-density / DENSITY_SCALE))
}

/** Craft component from a (valid) scorecard. */
export function craftScore(scorecard: Scorecard): number {
  const total = DIMENSIONS.reduce((sum, d) => sum + scorecard[d].score, 0)
  const mean = total / DIMENSIONS.length
  return Math.round(((mean - 1) / 4) * 100)
}

/** Composite; craft === null means "no scorecard" (overall = mechanics). */
export function overallScore(mechanics: number, craft: number | null): number {
  if (craft === null) return mechanics
  return Math.round(MECHANICS_WEIGHT * mechanics + (1 - MECHANICS_WEIGHT) * craft)
}

/** Display bucket for color coding: <50 low, <80 mid, ≥80 high. */
export function scoreLevel(score: number): 'low' | 'mid' | 'high' {
  if (score < 50) return 'low'
  if (score < 80) return 'mid'
  return 'high'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scoring/score.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run the whole frontend suite and build**

Run: `npx vitest run && npm run build`
Expected: all tests pass, build green.

- [ ] **Step 6: Commit**

```bash
git add src/scoring/score.ts src/scoring/score.test.ts
git commit -m "feat: pure scoring module implementing scoring v1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Store fields, editor wiring, i18n keys

**Files:**
- Modify: `frontend/src/state/store.ts`
- Modify: `frontend/src/editor/Editor.tsx`
- Modify: `frontend/src/i18n/messages.ts` and all of `frontend/src/i18n/{en,de,es,fr,it,ja,zh}.ts`

**Interfaces:**
- Consumes: `wordCount`, `Scorecard` from `../scoring/score` (Task 2).
- Produces (used by Tasks 5, 6): store fields `scorecard: Scorecard | null`, `scorecardStale: boolean`, `docWords: number`; actions `setScorecard(scorecard: Scorecard): void` (also clears staleness), `markScorecardStale(): void` (no-op while scorecard is null), `setDocWords(docWords: number): void`. i18n keys listed in Step 3.

- [ ] **Step 1: Add store state** (`frontend/src/state/store.ts`)

Import the type at the top (type-only, keeps the store's dependency direction clean):

```typescript
import type { Scorecard } from '../scoring/score'
```

In `interface AppState`, after the `rulesCollapsed` field block, add:

```typescript
  // Last LLM scorecard for the current document (kept until the next one
  // arrives); stale once the text was edited after it arrived.
  scorecard: Scorecard | null
  scorecardStale: boolean
  // Live word count of the editor document (feeds the quality score).
  docWords: number
```

and among the actions:

```typescript
  setScorecard: (scorecard: Scorecard) => void
  markScorecardStale: () => void
  setDocWords: (docWords: number) => void
```

In the `create()` initializer, after `rulesCollapsed: [],`:

```typescript
      scorecard: null,
      scorecardStale: false,
      docWords: 0,
```

and among the action implementations (after `setRulesCollapsed`):

```typescript
      setScorecard: (scorecard) => set({ scorecard, scorecardStale: false }),
      markScorecardStale: () =>
        set((state) => (state.scorecard ? { scorecardStale: true } : {})),
      setDocWords: (docWords) => set({ docWords }),
```

Do NOT add any of these to `partialize` — they share the findings' lifetime, not the settings'.

- [ ] **Step 2: Wire the editor** (`frontend/src/editor/Editor.tsx`)

Add the import:

```typescript
import { wordCount } from '../scoring/score'
```

In the `updateListener`, extend the `docChanged` branch:

```typescript
          if (update.docChanged) {
            localStorage.setItem(TEXT_STORAGE_KEY, update.state.doc.toString())
            scheduler.onInput()
            const store = useStore.getState()
            store.setDocWords(wordCount(update.state.doc.toString()))
            store.markScorecardStale()
          }
```

After `setEditorView(view)` (before `void runCheck(false)`), initialize the count for the restored document:

```typescript
    useStore.getState().setDocWords(wordCount(view.state.doc.toString()))
```

- [ ] **Step 3: Add the i18n keys**

In `frontend/src/i18n/messages.ts`, add to the `Messages` interface (near the other sidebar keys), including the type import at the top:

```typescript
import type { Dimension } from '../scoring/score'
```

```typescript
  scoreBadgeTitle: string
  scoreTooShort: string
  scoreMechanicsOnly: string
  scoreOutdated: string
  scoreMechanics: string
  scoreCraft: string
  dimensionName: (dimension: Dimension) => string
```

Then add the keys to **all seven** locale files (placement: right after the `findings`/sidebar block in each). Exact values:

`en.ts`:
```typescript
  scoreBadgeTitle: 'Overall quality score — click for details',
  scoreTooShort: 'Too short to score (minimum 40 words)',
  scoreMechanicsOnly: 'Mechanics only — run an LLM check for the full score',
  scoreOutdated: 'The craft rating predates your latest edits',
  scoreMechanics: 'Mechanics',
  scoreCraft: 'Craft',
  dimensionName: (d) =>
    ({
      consistency: 'consistency',
      flow: 'flow',
      clarity: 'clarity',
      vividness: 'vividness',
      tone: 'tone',
      structure: 'structure',
    })[d],
```

`de.ts`:
```typescript
  scoreBadgeTitle: 'Gesamtqualität — klicken für Details',
  scoreTooShort: 'Zu kurz für eine Bewertung (mindestens 40 Wörter)',
  scoreMechanicsOnly: 'Nur Mechanik — LLM-Prüfung für die vollständige Bewertung ausführen',
  scoreOutdated: 'Die Handwerks-Bewertung ist älter als der aktuelle Text',
  scoreMechanics: 'Mechanik',
  scoreCraft: 'Handwerk',
  dimensionName: (d) =>
    ({
      consistency: 'Konsistenz',
      flow: 'Lesefluss',
      clarity: 'Klarheit',
      vividness: 'Lebendigkeit',
      tone: 'Ton',
      structure: 'Struktur',
    })[d],
```

`es.ts`:
```typescript
  scoreBadgeTitle: 'Calidad general — clic para ver detalles',
  scoreTooShort: 'Demasiado corto para puntuar (mínimo 40 palabras)',
  scoreMechanicsOnly: 'Solo mecánica — ejecuta una comprobación LLM para la puntuación completa',
  scoreOutdated: 'La valoración de oficio es anterior a los últimos cambios',
  scoreMechanics: 'Mecánica',
  scoreCraft: 'Oficio',
  dimensionName: (d) =>
    ({
      consistency: 'consistencia',
      flow: 'fluidez',
      clarity: 'claridad',
      vividness: 'viveza',
      tone: 'tono',
      structure: 'estructura',
    })[d],
```

`fr.ts`:
```typescript
  scoreBadgeTitle: 'Qualité globale — cliquer pour les détails',
  scoreTooShort: 'Texte trop court pour une note (minimum 40 mots)',
  scoreMechanicsOnly: 'Mécanique seule — lancez une vérification LLM pour la note complète',
  scoreOutdated: 'L’évaluation du métier précède vos dernières modifications',
  scoreMechanics: 'Mécanique',
  scoreCraft: 'Métier',
  dimensionName: (d) =>
    ({
      consistency: 'cohérence',
      flow: 'fluidité',
      clarity: 'clarté',
      vividness: 'vivacité',
      tone: 'ton',
      structure: 'structure',
    })[d],
```

`it.ts`:
```typescript
  scoreBadgeTitle: 'Qualità complessiva — clic per i dettagli',
  scoreTooShort: 'Testo troppo breve per un punteggio (minimo 40 parole)',
  scoreMechanicsOnly: 'Solo meccanica — esegui un controllo LLM per il punteggio completo',
  scoreOutdated: 'La valutazione del mestiere è precedente alle ultime modifiche',
  scoreMechanics: 'Meccanica',
  scoreCraft: 'Mestiere',
  dimensionName: (d) =>
    ({
      consistency: 'coerenza',
      flow: 'fluidità',
      clarity: 'chiarezza',
      vividness: 'vividezza',
      tone: 'tono',
      structure: 'struttura',
    })[d],
```

`ja.ts`:
```typescript
  scoreBadgeTitle: '総合品質スコア — クリックで詳細',
  scoreTooShort: 'スコアを算出するには短すぎます（40語以上必要）',
  scoreMechanicsOnly: '基礎スコアのみ — 完全なスコアにはLLMチェックを実行してください',
  scoreOutdated: '文章力の評価は最新の編集より前のものです',
  scoreMechanics: '基礎',
  scoreCraft: '文章力',
  dimensionName: (d) =>
    ({
      consistency: '一貫性',
      flow: '流れ',
      clarity: '明瞭さ',
      vividness: '鮮やかさ',
      tone: 'トーン',
      structure: '構成',
    })[d],
```

`zh.ts`:
```typescript
  scoreBadgeTitle: '总体质量评分 — 点击查看详情',
  scoreTooShort: '文本太短，无法评分（至少 40 词）',
  scoreMechanicsOnly: '仅基础评分 — 运行 LLM 检查以获得完整评分',
  scoreOutdated: '文笔评价早于最近的修改',
  scoreMechanics: '基础',
  scoreCraft: '文笔',
  dimensionName: (d) =>
    ({
      consistency: '一致性',
      flow: '流畅度',
      clarity: '清晰度',
      vividness: '生动性',
      tone: '语气',
      structure: '结构',
    })[d],
```

- [ ] **Step 4: Verify**

Run (from `frontend/`): `npx vitest run && npm run build`
Expected: all tests pass (including the i18n key-parity test), build green.

- [ ] **Step 5: Commit**

```bash
git add src/state/store.ts src/editor/Editor.tsx src/i18n/
git commit -m "feat: scorecard/word-count state, staleness wiring, score i18n keys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend — Scorecard model and response parsing (TDD)

**Files:**
- Modify: `backend/app/core/models.py`
- Modify: `backend/app/checkers/llm/checker.py`
- Test: `backend/tests/test_llm_checker.py`

**Interfaces:**
- Produces (used by Task 5):
  - `app.core.models.ScoreDimension` (`score: int` 1–5, `note: str = ""`) and `Scorecard` (six required `ScoreDimension` fields: `consistency, flow, clarity, vividness, tone, structure`).
  - `parse_response(response: str) -> ParsedResponse` where `ParsedResponse` is a NamedTuple `(findings: list[RawFinding], scorecard: Scorecard | None)`.
  - `LLMChecker.check(...)` now returns `LLMCheckResult` (dataclass: `findings: list[Finding]`, `scorecard: Scorecard | None`) instead of `list[Finding]`.
- `parse_findings()` stays as a thin wrapper (`parse_response(response).findings`) so existing callers/tests keep working.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_llm_checker.py`)

Note: the existing async tests in this file (`test_anchors_findings_and_discards_unanchorable`, `test_severity_defaults_to_warning`, `test_inline_suggestions_are_vetted_but_finding_survives`) call `await checker.check(...)` and treat the result as a list — Step 3 changes the return type, so **also update those three tests** to unpack `result.findings`. New tests:

```python
SCORECARD = {
    "consistency": {"score": 4, "note": "Terminology is uniform."},
    "flow": {"score": 3, "note": "Transitions are functional."},
    "clarity": {"score": 4, "note": "Mostly easy to follow."},
    "vividness": {"score": 2, "note": "Abstract throughout."},
    "tone": {"score": 5, "note": "Fits the genre well."},
    "structure": {"score": 3, "note": "Sound but flat ordering."},
}

FINDING_ITEM = {
    "category": "style",
    "severity": "warning",
    "quote": "very good",
    "message": "Weak intensifier.",
    "suggestions": ["excellent"],
}


class TestParseResponse:
    def test_object_with_findings_and_scorecard(self) -> None:
        response = json.dumps({"findings": [FINDING_ITEM], "scorecard": SCORECARD})
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert findings[0].quote == "very good"
        assert scorecard is not None
        assert scorecard.vividness.score == 2
        assert scorecard.tone.note == "Fits the genre well."

    def test_object_without_scorecard(self) -> None:
        response = json.dumps({"findings": [FINDING_ITEM]})
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert scorecard is None

    def test_scorecard_missing_dimension_discarded_findings_kept(self) -> None:
        incomplete = {k: v for k, v in SCORECARD.items() if k != "flow"}
        response = json.dumps({"findings": [FINDING_ITEM], "scorecard": incomplete})
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert scorecard is None  # strict gate: no partial scorecards

    def test_scorecard_out_of_range_discarded(self) -> None:
        bad = {**SCORECARD, "flow": {"score": 6, "note": ""}}
        response = json.dumps({"findings": [FINDING_ITEM], "scorecard": bad})
        assert parse_response(response).scorecard is None

    def test_bare_array_fallback_has_no_scorecard(self) -> None:
        response = json.dumps([FINDING_ITEM])
        findings, scorecard = parse_response(response)
        assert len(findings) == 1
        assert scorecard is None

    def test_single_item_array_not_mistaken_for_envelope(self) -> None:
        # A one-element bare array contains a top-level {...} substring that
        # parses as an object but is a finding, not the envelope.
        response = json.dumps([FINDING_ITEM])
        findings, _ = parse_response(response)
        assert findings[0].message == "Weak intensifier."

    def test_object_in_code_fence(self) -> None:
        payload = json.dumps({"findings": [], "scorecard": SCORECARD})
        response = f"```json\n{payload}\n```"
        assert parse_response(response).scorecard is not None

    def test_note_is_optional(self) -> None:
        no_notes = {k: {"score": v["score"]} for k, v in SCORECARD.items()}
        response = json.dumps({"findings": [], "scorecard": no_notes})
        scorecard = parse_response(response).scorecard
        assert scorecard is not None
        assert scorecard.consistency.note == ""
```

Add the imports at the top of the file: `parse_response` from `app.checkers.llm.checker` (alongside the existing imports) and `import json` if not present.

- [ ] **Step 2: Run to verify the new tests fail**

Run (from `backend/`): `uv run pytest tests/test_llm_checker.py -v`
Expected: new tests FAIL with ImportError (`parse_response` not defined); existing tests pass.

- [ ] **Step 3: Implement**

In `backend/app/core/models.py`, append:

```python
class ScoreDimension(BaseModel):
    score: int = Field(ge=1, le=5)
    note: str = ""


class Scorecard(BaseModel):
    """Holistic per-dimension assessment returned alongside LLM findings.

    All six dimensions are required: an incomplete or out-of-range scorecard
    fails validation and is discarded whole (the strict gate; see
    docs/scoring.md).
    """

    consistency: ScoreDimension
    flow: ScoreDimension
    clarity: ScoreDimension
    vividness: ScoreDimension
    tone: ScoreDimension
    structure: ScoreDimension
```

In `backend/app/checkers/llm/checker.py`:

Update imports:

```python
from dataclasses import dataclass
from typing import NamedTuple

from app.core.models import Category, Finding, Language, Scorecard, Severity, Source
```

After `extract_json_array`, add:

```python
def extract_json_object(response: str) -> dict | None:
    """Extract a top-level JSON object, tolerating fences and prose."""
    candidates = [response, _CODE_FENCE.sub("", response).strip()]
    start, end = response.find("{"), response.rfind("}")
    if start != -1 and end > start:
        candidates.append(response[start : end + 1])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    return None


class ParsedResponse(NamedTuple):
    findings: list[RawFinding]
    scorecard: Scorecard | None


def parse_response(response: str) -> ParsedResponse:
    """Parse the check response: object envelope, or bare-array fallback.

    The envelope must have a "findings" list — a lone finding object (e.g.
    the {...} inside a one-element bare array) is not mistaken for it. A
    scorecard that fails validation is discarded whole (strict gate); the
    findings from the same response are unaffected.
    """
    data = extract_json_object(response)
    if data is not None and isinstance(data.get("findings"), list):
        scorecard = None
        if data.get("scorecard") is not None:
            try:
                scorecard = Scorecard.model_validate(data["scorecard"])
            except ValidationError:
                scorecard = None
        return ParsedResponse(_validate_findings(data["findings"]), scorecard)
    return ParsedResponse(_validate_findings(extract_json_array(response) or []), None)


def _validate_findings(items: list) -> list[RawFinding]:
    findings = []
    for item in items:
        try:
            findings.append(RawFinding.model_validate(item))
        except ValidationError:
            continue
    return findings


def parse_findings(response: str) -> list[RawFinding]:
    """Extract findings from an LLM response, skipping invalid items."""
    return parse_response(response).findings
```

(Delete the old `parse_findings` body — the loop moves into `_validate_findings`.)

Change `LLMChecker.check` to return both parts:

```python
@dataclass
class LLMCheckResult:
    findings: list[Finding]
    scorecard: Scorecard | None
```

and in `check()`: replace `for raw in parse_findings(response):` with

```python
        raw_findings, scorecard = parse_response(response)
        findings: list[Finding] = []
        for raw in raw_findings:
```

and the final lines with

```python
        findings.sort(key=lambda f: (f.span.start, f.span.end))
        return LLMCheckResult(findings=findings, scorecard=scorecard)
```

(update the method's return annotation to `-> "LLMCheckResult"`, defining the dataclass above the class). Update the three existing async tests to use `result = await checker.check(...)` / `result.findings`.

- [ ] **Step 4: Run the backend suite**

Run: `uv run pytest tests/test_llm_checker.py -v` then `uv run pytest`
Expected: all pass — except `backend/app/api/checks.py` still treats `check()`'s result as a list, so `tests/test_check_api.py` may fail. If it does, proceed immediately to Task 5 Step 3's `_run_llm` change (the two tasks share one commit boundary decision: commit only once `uv run pytest` is fully green — do NOT commit a red state between Tasks 4 and 5; if needed, do Task 5 Steps 1–3 first and commit both together).

- [ ] **Step 5: Commit** (only if the full suite is green; otherwise fold into Task 5's commit)

```bash
git add app/core/models.py app/checkers/llm/checker.py tests/test_llm_checker.py
git commit -m "feat: scorecard model and object-envelope response parsing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Backend — prompt contract, job event, API field (TDD)

**Files:**
- Modify: `backend/app/checkers/llm/prompts.py`
- Modify: `backend/app/services/jobs.py`
- Modify: `backend/app/api/checks.py`
- Test: `backend/tests/test_check_api.py`, `backend/tests/test_prompts.py`

**Interfaces:**
- Consumes: `Scorecard`, `LLMCheckResult` (Task 4).
- Produces (used by Task 6): SSE event `scorecard` whose data is the scorecard's six dimensions (`{"consistency": {"score": 4, "note": "..."}, ...}`); `CheckStatus.scorecard: Scorecard | None` on both `POST /api/checks` and `GET /api/checks/{id}`.

- [ ] **Step 1: Write the failing API test** (append to `backend/tests/test_check_api.py`)

```python
SCORECARD = {
    "consistency": {"score": 4, "note": "Terminology is uniform."},
    "flow": {"score": 3, "note": "Transitions are functional."},
    "clarity": {"score": 4, "note": "Mostly easy to follow."},
    "vividness": {"score": 2, "note": "Abstract throughout."},
    "tone": {"score": 5, "note": "Fits the genre well."},
    "structure": {"score": 3, "note": "Sound but flat ordering."},
}


def test_scorecard_streams_and_polls(tmp_path: Path) -> None:
    response = json.dumps({"findings": json.loads(LLM_RESPONSE), "scorecard": SCORECARD})
    with make_client(tmp_path, FakeProvider(response)) as client:
        check = client.post(
            "/api/checks",
            json={"text": "A nice text.", "language": "en", "checkers": ["llm"]},
        ).json()
        assert check["scorecard"] is None  # LLM still running at POST time
        with client.stream("GET", f"/api/checks/{check['check_id']}/events") as stream:
            events = _read_sse_events(stream)
        final = client.get(f"/api/checks/{check['check_id']}").json()

    scorecard_events = [data for name, data in events if name == "scorecard"]
    assert scorecard_events == [SCORECARD]
    assert final["scorecard"] == SCORECARD
    # Findings from the same (object-form) response still arrive normally.
    assert any(f["span"]["text"] == "nice" for f in final["findings"])


def test_bare_array_response_yields_null_scorecard(client: TestClient) -> None:
    check = client.post(
        "/api/checks",
        json={"text": "A nice text.", "language": "en", "checkers": ["llm"]},
    ).json()
    with client.stream("GET", f"/api/checks/{check['check_id']}/events") as stream:
        events = _read_sse_events(stream)
    final = client.get(f"/api/checks/{check['check_id']}").json()
    assert final["scorecard"] is None
    assert all(name != "scorecard" for name, _ in events)
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_check_api.py -v -k scorecard`
Expected: FAIL — `KeyError: 'scorecard'` (field doesn't exist yet).

- [ ] **Step 3: Implement**

`backend/app/services/jobs.py` — import `Scorecard`, add job state + setter:

```python
from app.core.models import Finding, Scorecard
```

In `CheckJob.__init__`, after `self.skipped_rules`:

```python
        self.scorecard: Scorecard | None = None
```

After `add_findings`:

```python
    def set_scorecard(self, scorecard: Scorecard) -> None:
        self.scorecard = scorecard
        self.emit("scorecard", scorecard.model_dump(mode="json"))
```

`backend/app/api/checks.py` — import `Scorecard` (extend the existing `from app.core.models import ...`), add the response field:

```python
class CheckStatus(BaseModel):
    check_id: str
    status: str
    findings: list[Finding]
    skipped_rules: list[str] = Field(default_factory=list)
    scorecard: Scorecard | None = None
```

In `_run_llm`, replace the two lines inside `try:` after `checker = ...` with:

```python
        result = await checker.check(
            text, language, on_progress=on_progress, instructions=instructions
        )
        job.add_findings("llm", drop_duplicates(result.findings, job.findings))
        if result.scorecard is not None:
            job.set_scorecard(result.scorecard)
```

In both `create_check`'s return and `get_check`'s return, add `scorecard=job.scorecard,`.

`backend/app/checkers/llm/prompts.py` — replace the output-contract section of `_SYSTEM_TEMPLATE` (everything from `Respond with ONLY a JSON array.` through the end of the template) with:

```python
Respond with ONLY a JSON object with exactly two keys, "findings" and "scorecard".

"findings": an array of issues. Each element:
{{
  "category": "<one of the categories above>",
  "severity": "error" | "warning" | "suggestion",
  "quote": "<the EXACT problematic text, copied verbatim from the input, max ~15 words>",
  "context_before": "<the few words immediately preceding the quote, verbatim>",
  "message": "<short explanation for the writer, in {language}>",
  "suggestions": ["<improved replacement for exactly the quoted text>", ...]
}}

"scorecard": a holistic assessment of the WHOLE text with exactly these six
dimensions, each an integer score 1-5 plus a one-sentence justification in {language}:
{{
  "consistency": {{"score": <1-5>, "note": "<one sentence>"}},
  "flow": {{...}}, "clarity": {{...}}, "vividness": {{...}},
  "tone": {{...}}, "structure": {{...}}
}}

Scorecard dimensions:
- consistency: uniform terminology, register, and stylistic choices throughout
- flow: transitions, rhythm, sentence-length variety
- clarity: how understandable the document is as a whole
- vividness: engagement, concreteness, imagery
- tone: how well tone and formality fit the review instructions (if any) and the text's evident genre
- structure: organization, paragraphing, logical order for this kind of text

Score anchors: 1 = seriously deficient, 2 = weak, 3 = competent, 4 = strong, 5 = exemplary.

Rules:
- "quote" MUST be copied character-for-character from the input text; never paraphrase it.
- Each suggestion must be a drop-in replacement for the quote.
- Report at most 15 of the most important issues. If the text is fine, "findings" is [].
- The scorecard judges the text as a whole, independent of how many issues you list.
"""
```

Update `backend/tests/test_prompts.py`: the two assertions on `"Respond with ONLY a JSON array"` (lines 12 and 19) become `"Respond with ONLY a JSON object"`.

- [ ] **Step 4: Run the full backend suite**

Run: `uv run pytest`
Expected: all pass (including `tests/test_prompts.py` and the Task 4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/checkers/llm/prompts.py app/services/jobs.py app/api/checks.py tests/test_check_api.py tests/test_prompts.py
git commit -m "feat: LLM check returns a scorecard via prompt envelope, SSE, and polling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — SSE wiring, score badge, score panel

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/checking/controller.ts`
- Create: `frontend/src/sidebar/Score.tsx`
- Modify: `frontend/src/sidebar/Sidebar.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes: scoring module (Task 2), store fields/actions (Task 3), SSE `scorecard` event + `CheckStatus.scorecard` (Task 5).
- Produces: `<ScoreBadge open onToggle />` and `<ScorePanel />` components exported from `frontend/src/sidebar/Score.tsx`.

- [ ] **Step 1: Types and API client**

`frontend/src/types.ts` — re-export the scorecard type for API surfaces and add the response field:

```typescript
import type { Scorecard } from './scoring/score'
export type { Scorecard }
```

```typescript
export interface CheckStatus {
  check_id: string
  status: string
  findings: Finding[]
  scorecard: Scorecard | null
}
```

`frontend/src/api/client.ts` — add `Scorecard` to the type import from `../types`, extend the handlers and subscription:

```typescript
export interface CheckEventHandlers {
  onResult: (checker: string, findings: Finding[]) => void
  onError: (checker: string, error: string) => void
  onDone: () => void
  onProgress?: (tokens: number) => void
  onScorecard?: (scorecard: Scorecard) => void
}
```

In `subscribeCheck`, after the `llm_progress` listener:

```typescript
  source.addEventListener('scorecard', (event) => {
    const data = JSON.parse((event as MessageEvent).data)
    handlers.onScorecard?.(data)
  })
```

- [ ] **Step 2: Controller wiring** (`frontend/src/checking/controller.ts`)

In the `subscribeCheck` handlers object (after `onProgress`), add:

```typescript
    onScorecard(scorecard) {
      if (currentCheckId !== checkId) return
      const view = getEditorView()
      useStore.getState().setScorecard(scorecard)
      // The scorecard describes the checked snapshot; if the user kept
      // typing it is immediately outdated (unlike findings it has no
      // offsets, so it is kept rather than discarded).
      if (view && view.state.doc.toString() !== text) {
        useStore.getState().markScorecardStale()
      }
    },
```

- [ ] **Step 3: Score components** (create `frontend/src/sidebar/Score.tsx`)

```tsx
import { useMemo } from 'react'
import { useMessages } from '../i18n'
import {
  craftScore,
  DIMENSIONS,
  mechanicsScore,
  overallScore,
  scoreLevel,
} from '../scoring/score'
import { useStore } from '../state/store'

/** Overall / mechanics / craft for the current document, or null if too short. */
function useScores() {
  const tracked = useStore((s) => s.tracked)
  const docWords = useStore((s) => s.docWords)
  const scorecard = useStore((s) => s.scorecard)
  const mechanics = useMemo(
    () => mechanicsScore(tracked.map((t) => t.finding), docWords),
    [tracked, docWords],
  )
  if (mechanics === null) return null
  const craft = scorecard ? craftScore(scorecard) : null
  return { mechanics, craft, overall: overallScore(mechanics, craft) }
}

export function ScoreBadge({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const stale = useStore((s) => s.scorecardStale)
  const m = useMessages()
  const scores = useScores()

  if (!scores) {
    return (
      <span className="score-badge score-none" title={m.scoreTooShort}>
        –
      </span>
    )
  }
  const { craft, overall } = scores
  const title =
    craft === null ? m.scoreMechanicsOnly : stale ? m.scoreOutdated : m.scoreBadgeTitle
  return (
    <button
      className={`score-badge score-${scoreLevel(overall)}`}
      title={title}
      aria-expanded={open}
      onClick={onToggle}
    >
      {overall}
      {craft === null ? (
        <span className="score-mark">◐</span>
      ) : stale ? (
        <span className="score-mark">⟳</span>
      ) : null}
    </button>
  )
}

export function ScorePanel() {
  const scorecard = useStore((s) => s.scorecard)
  const stale = useStore((s) => s.scorecardStale)
  const m = useMessages()
  const scores = useScores()
  if (!scores) return null
  const { mechanics, craft, overall } = scores

  return (
    <div className="score-panel">
      <div className="score-panel-head">
        <span className={`score-number score-${scoreLevel(overall)}`}>{overall}</span>
        <span className="score-split">
          {m.scoreMechanics} {mechanics}
          {craft !== null && (
            <>
              {' · '}
              {m.scoreCraft} {craft}
            </>
          )}
        </span>
      </div>
      {(craft === null || stale) && (
        <p className="score-freshness">
          {craft === null ? m.scoreMechanicsOnly : m.scoreOutdated}
        </p>
      )}
      {scorecard && (
        <div className="score-dimensions">
          {DIMENSIONS.map((dimension) => (
            <div key={dimension} className="score-dimension">
              <div className="score-dimension-row">
                <span className="score-dimension-name">
                  {m.dimensionName(dimension)}
                </span>
                <span className="score-dimension-bar">
                  {[1, 2, 3, 4, 5].map((step) => (
                    <span
                      key={step}
                      className={`score-seg${
                        scorecard[dimension].score >= step ? ' filled' : ''
                      }`}
                    />
                  ))}
                </span>
              </div>
              {scorecard[dimension].note && (
                <p className="score-dimension-note">{scorecard[dimension].note}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Sidebar integration** (`frontend/src/sidebar/Sidebar.tsx`)

Import the components and add panel state at the top of `Sidebar()`:

```typescript
import { ScoreBadge, ScorePanel } from './Score'
```

```typescript
  const [scoreOpen, setScoreOpen] = useState(false)
```

In the header, put the badge inside the existing `<h2>` after the count badge, and render the panel right after `.sidebar-header`:

```tsx
        <div className="sidebar-header">
          <h2>
            {m.findings} <span className="count-badge">{total}</span>
            <ScoreBadge open={scoreOpen} onToggle={() => setScoreOpen(!scoreOpen)} />
          </h2>
          {checkPhase !== 'idle' && <CheckStatus phase={checkPhase} />}
        </div>
        {scoreOpen && <ScorePanel />}
```

- [ ] **Step 5: CSS** (append to `frontend/src/App.css`, sidebar section)

```css
/* ---- quality score ---- */

.score-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.05rem 0.5rem;
  border-radius: 999px;
  border: 1px solid;
  background: none;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  vertical-align: middle;
}

span.score-badge {
  cursor: default;
}

.score-none {
  color: var(--text-dim);
  border-color: var(--border);
  font-weight: 400;
}

.score-high { color: #12a594; }
.score-mid { color: #ffb224; }
.score-low { color: #e5484d; }

.score-mark {
  font-size: 0.72em;
  margin-left: 0.2rem;
  opacity: 0.8;
}

.score-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.6rem 0.75rem;
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.score-panel-head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.score-number {
  font-size: 1.5rem;
  font-weight: 700;
}

.score-split {
  color: var(--text-dim);
  font-size: 0.78rem;
}

.score-freshness {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.78rem;
  font-style: italic;
}

.score-dimensions {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.score-dimension-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.score-dimension-name {
  flex: 1;
  font-size: 0.82rem;
}

.score-dimension-bar {
  display: inline-flex;
  gap: 2px;
}

.score-seg {
  width: 14px;
  height: 6px;
  border-radius: 2px;
  background: var(--accent-soft);
}

.score-seg.filled {
  background: var(--accent);
}

.score-dimension-note {
  margin: 0.1rem 0 0;
  color: var(--text-dim);
  font-size: 0.75rem;
}
```

- [ ] **Step 6: Verify**

Run (from `frontend/`): `npx vitest run && npm run build`
Expected: all tests pass, build green.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/api/client.ts src/checking/controller.ts src/sidebar/Score.tsx src/sidebar/Sidebar.tsx src/App.css
git commit -m "feat: quality score badge and panel in the sidebar

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end verification, docs, logbook

**Files:**
- Create: e2e script in the session scratchpad (throwaway, not committed)
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `README.md`, `docs/LOGBOOK.md`

- [ ] **Step 1: E2E script (headless Chrome against the live dev servers)**

Prerequisites: backend on :8000, frontend on :5173 (both already run in this environment). Write the script to the scratchpad directory and run with `node` from `frontend/` (playwright-core is a dependency there). The script must create no server-side data and restore nothing (it only types in the editor, which persists to localStorage — clear it at the end).

```javascript
// e2e-score.mjs — verify the quality score end to end.
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
let checks = 0
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().includes('/api/checks')) checks++
})

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)

// 1. Short default text → too-short badge (default doc is < 40 words).
const badge = page.locator('.score-badge')
console.log('1. badge (short text):', await badge.textContent(), '/',
  await badge.getAttribute('title'))

// 2. Load the EN example (long, flawed) → numeric mechanics-only badge.
await page.locator('.load-example').click()
await page.waitForTimeout(3000) // fast check ran
const initialText = (await badge.textContent()).trim()
console.log('2. badge after example + fast check:', initialText)
if (!/^\d+◐?$/.test(initialText)) throw new Error('expected numeric mechanics-only badge')
const initial = parseInt(initialText, 10)

// 3. Apply a one-click fix → score must rise WITHOUT a new POST /api/checks.
const before = checks
await page.locator('.finding-row').first().click()
await page.waitForTimeout(300)
await page.locator('.suggestion-button').first().click()
await page.waitForTimeout(500)
const afterFix = parseInt((await badge.textContent()).trim(), 10)
console.log('3. score after fix:', initial, '→', afterFix, '| new checks:', checks - before)
if (afterFix <= initial) throw new Error('score did not rise after applying a fix')
if (checks !== before) throw new Error('applying a fix must not trigger a check')

// 4. Open the panel → mechanics-only note, no dimensions yet.
await badge.click()
console.log('4. panel open:', await page.locator('.score-panel').count(),
  '| freshness:', await page.locator('.score-freshness').textContent())

// 5. (needs Ollama) Run an LLM check → scorecard arrives, dimensions render.
await page.locator('.llm-select-row select').selectOption('local')
await page.waitForTimeout(300)
await page.locator('button:has-text("Check")').click()
await page.locator('.score-dimension').first().waitFor({ timeout: 180000 })
console.log('5. dimensions:', await page.locator('.score-dimension').count(),
  '| badge:', await badge.textContent())

// 6. Type → staleness marker appears.
await page.locator('.cm-content').click()
await page.keyboard.type(' More words here.')
await page.waitForTimeout(300)
const staleTitle = await badge.getAttribute('title')
console.log('6. after edit, badge title:', staleTitle)
await page.screenshot({ path: process.env.SHOT ?? 'e2e-score.png', fullPage: false })

await page.evaluate(() => localStorage.clear())
await browser.close()
console.log('E2E PASS')
```

Adjust selectors against the real DOM if any step fails to locate (e.g. the Check button's accessible name is locale-dependent — the dev default is English). Step 5 requires Ollama; if it is not running, log and skip steps 5–6 rather than failing, and say so in the report.

- [ ] **Step 2: Run it and read the screenshot**

Run from `frontend/`: `node <scratchpad>/e2e-score.mjs`
Expected: `E2E PASS`, score rises after the fix with zero new checks, six `.score-dimension` rows after the LLM check. View the screenshot to confirm the badge and panel look right.

- [ ] **Step 3: Update the architecture docs**

- `docs/backend-architecture.md`: in "The check flow", add the `scorecard` SSE event to the event list and the nullable `scorecard` field to the polling response; in "Prompts", note the object envelope (`{"findings": [...], "scorecard": {...}}`) with bare-array fallback; in "Parsing, anchoring, vetting", one sentence on the strict scorecard gate (invalid → discarded whole, findings unaffected).
- `docs/frontend-architecture.md`: add the `scoring/` module to the module map (pure scoring v1 implementation, normative spec in `docs/scoring.md`, golden tests) and a short paragraph on the score state (store fields `scorecard`/`scorecardStale`/`docWords`, staleness on edit, badge + panel in the sidebar).

- [ ] **Step 4: README + logbook**

- `README.md`: add one feature bullet ("Overall quality score: live 0–100 gauge combining a deterministic mechanics score with a six-dimension LLM craft scorecard — see `docs/scoring.md`").
- `docs/LOGBOOK.md`: append the work summary with commit pointers, per convention.

- [ ] **Step 5: Final verification and commit**

Run: `cd backend && uv run pytest` and `cd frontend && npx vitest run && npm run build`
Expected: everything green.

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md README.md docs/LOGBOOK.md
git commit -m "docs: architecture, README, and logbook for the quality score

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

(Push any earlier unpushed commits with this final push.)
