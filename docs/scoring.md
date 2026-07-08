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
