# Text Quality Score — Design

Date: 2026-07-08
Status: approved (brainstorm with Markus, 2026-07-08)

## Goal

Give every text an at-a-glance **overall quality score (0–100)** with a per-dimension
breakdown, so the writer can watch the score climb as they revise. The score combines
what the checkers already find with a holistic judgment of qualities no span-level
finding captures: consistency, flow, clarity, vividness, tone/formality fit, and
structure — judged against the expectations of the active profile/domain.

Primary purposes, phased:

1. **Live revision gauge** (v1) — updates instantly as findings are fixed.
2. **Diagnostic breakdown** (v1) — per-dimension ratings show *where* the text is weak.
3. **Publish-readiness gate** (later) — per-profile target thresholds.

## Architecture decision (Approach B)

**The backend delivers ingredients; the frontend computes the score.**

Rationale: findings live in the frontend (CodeMirror `StateField`) and resolve
*instantly* when a fix is applied or flagged text is edited. Only a client-side
computation can make the gauge react live to fixes without a round-trip — the heart of
the revision-gauge experience. Blending a fresh mechanics part with the last-known
holistic part across checks requires client state anyway.

Backend's only new job: the existing LLM check additionally returns a **scorecard**
(no extra LLM call — it piggybacks on the check prompt), validated behind a
deterministic gate and streamed to the client as a new SSE event.

Consequences, addressed by design:

- **Reimplementability**: the scoring method is specified normatively in
  `docs/scoring.md` (formulas, constants, word counting, gates, worked examples) so
  future non-browser clients can reimplement it exactly. The method carries a version
  tag (**scoring v1**); any formula change bumps it.
- **Reusability**: the computation lives in a framework-free TypeScript module
  (`frontend/src/scoring/`) with zero imports from React/zustand/CodeMirror, usable by
  any TS client as-is.

## Scoring model (scoring v1)

Two components, one composite. All constants below are v1 defaults — deliberately
tunable once the feature is observed in action; they live in one place in the module
and in `docs/scoring.md`.

### Mechanics (0–100, deterministic, local)

Computed from the **current live finding list** (not the last check response):

```
points     = 5·errors + 2·warnings + 0.5·suggestions
density    = points / words × 100
mechanics  = round(100 · e^(−density / 15))
```

- Exponential decay: a clean text scores 100, the score never goes negative, and each
  additional issue hurts slightly less than the previous one.
- Examples: 200 words, 1 error + 4 warnings → points 13 → density 6.5 → **65**.
  200 words, 1 suggestion → points 0.5 → density 0.25 → **98**.

**Word count** (normative, language-aware): the number of maximal runs of
letters/digits (Unicode `[\p{L}\p{N}]+`) in the text, where each CJK character (Han,
Hiragana, Katakana) counts as **0.5 words** instead of participating in a run.
This keeps scores comparable between space-delimited and CJK languages.

**Minimum length**: texts under **40 words** get no score at all — the UI shows a
"too short to score" state. Scoring a headline is meaningless.

### Craft (0–100, from the LLM scorecard)

Six dimensions, each an integer **1–5** plus a one-sentence note:

| Dimension | Judges |
|---|---|
| `consistency` | uniform terminology, register, and stylistic choices throughout |
| `flow` | transitions, rhythm, sentence-length variety |
| `clarity` | document-level understandability (beyond span-level clarity findings) |
| `vividness` | engagement, concreteness, imagery |
| `tone` | tone & formality fit for the profile's stated expectations and evident genre |
| `structure` | organization, paragraphing, logical order for the domain |

```
craft = (mean(six scores) − 1) / 4 × 100        # all 3s → 50, all 5s → 100
```

The scorecard is judged **against the profile's expectations**: the check prompt's
rubric instructs the model to weigh the profile's `llm_instructions` (already injected
by `_with_instructions()`) and the text's evident genre. No new profile field.

### Composite

```
overall = round(0.5 · mechanics + 0.5 · craft)
```

- No scorecard yet (LLM never ran / offline / discarded): `overall = mechanics`,
  explicitly labeled **"mechanics only"** in the UI.
- Weights, severity points, and color thresholds are v1 values to be tuned in use.

### Staleness

The mechanics part is always fresh (recomputed from live findings). The craft part
keeps its **last received scorecard** until the next LLM check replaces it. Once the
document is edited after a scorecard arrived, the badge shows a subtle **"outdated"**
marker; the number is *not* artificially decayed. The next completed LLM check clears
the marker.

## Backend changes

Small and contained; no new endpoint, no DB change, no extra LLM call.

1. **Prompt contract** (`app/checkers/llm/prompts.py`): the full-check prompt's output
   contract changes from "only a JSON array" to a JSON **object**:

   ```json
   {"findings": [ ...as today... ],
    "scorecard": {"consistency": {"score": 4, "note": "..."},
                  "flow": {...}, "clarity": {...}, "vividness": {...},
                  "tone": {...}, "structure": {...}}}
   ```

   The prompt gains a brief rubric: one anchor line per level
   (1 = seriously deficient … 5 = exemplary) and the instruction to judge against the
   guidance section (profile instructions) and the text's genre. Profile instructions
   stay injected *after* the output-format contract, as today. Suggestion/rewrite
   prompts are unchanged.

2. **Parsing** (`app/checkers/llm/checker.py`): accept the new object form **and**
   fall back to the old bare-array form (findings-only, scorecard absent) — weaker
   local models that ignore the new instruction degrade gracefully instead of
   breaking the check.

3. **`Scorecard` model** (`app/core/models.py`): six required dimensions, each with
   `score: int` (1–5) and `note: str`. **Strict gate** in the spirit of anchoring:
   a scorecard missing any dimension, with out-of-range scores, or otherwise invalid
   is **discarded entirely** (a `scorecard` of `null`); the findings from the same
   response are unaffected. No partial scorecards.

4. **Delivery**: a new SSE event `scorecard {dimensions...}` emitted after the LLM
   `checker_result`; the polling fallback `GET /api/checks/{id}` gains a nullable
   `scorecard` field. Notes arrive in the text's language (like LLM finding messages).

## Frontend changes

1. **Scoring module** `frontend/src/scoring/score.ts` — pure TypeScript, zero
   React/zustand/CodeMirror imports. Exports:
   - `wordCount(text: string): number`
   - `mechanicsScore(findings: {severity: Severity}[], words: number): number | null`
     (null under the 40-word minimum)
   - `craftScore(scorecard: Scorecard): number`
   - `overallScore(mechanics: number, craft: number | null): number`
   - the `Scorecard` TS type and the v1 constants, exported for display/tests.
   Findings enter as a minimal `{severity}` shape, not the app's full type, so the
   module has no app dependencies and can be extracted as a package unchanged.

2. **Store**: `scorecard: Scorecard | null` and `scorecardStale: boolean` in zustand
   (not persisted — same lifetime as findings). Set by the SSE `scorecard` event;
   `scorecardStale` set true on document edits, cleared on the next scorecard.

3. **UI**:
   - **Badge**: a compact color-coded score badge next to the "Findings" heading in
     the sidebar (red < 50, amber 50–79, green ≥ 80). Recomputes instantly when a fix
     is applied. States: score, "mechanics only" variant, "outdated" marker,
     "too short" placeholder.
   - **Score panel**: clicking the badge expands a panel with the overall number and
     freshness state, six dimension bars (1–5) with their notes, and the
     mechanics/craft split shown subtly.
   - i18n keys for all new strings across the 7 locales (`Messages` type + parity
     test enforce completeness).

4. **Normative doc** `docs/scoring.md`: formulas, constants, word-count rules, gate
   rules, version tag, and **worked examples with exact expected outputs**. The
   scoring module's unit tests use those same worked examples as golden tests, so
   doc and implementation cannot silently drift.

## Phasing

1. **Phase 1** — `docs/scoring.md` + scoring module (TDD) + mechanics-only badge in
   the sidebar. No backend change; fully functional offline.
2. **Phase 2** — backend scorecard (prompt, parser, `Scorecard` model, SSE), craft
   blend, score panel with dimension bars, staleness marker.
3. **Phase 3** (later, own spec) — per-profile target thresholds, on-demand deep
   prose critique (dedicated call, per-dimension critique text), score history/trend.

## Testing

- **Scoring module**: golden tests generated from `docs/scoring.md`'s worked examples,
  plus edge cases: empty text, exactly 40 words, pure-CJK text, mixed Latin/CJK,
  all-suggestions findings, clamping at 0/100.
- **Backend**: parser tests (object form; bare-array fallback; scorecard missing a
  dimension → discarded, findings kept; out-of-range score → discarded), prompt test
  asserting the rubric and contract text, FakeProvider-driven job test asserting the
  `scorecard` SSE event and the polling field.
- **E2E (headless Chrome)**: load example → check → badge appears with a plausible
  score; apply a one-click fix → the score rises without a new `POST /api/checks`;
  scorecard arrival flips the badge from "mechanics only" to the blended score.

## Out of scope (this spec)

- Per-profile score thresholds / publish gating (phase 3).
- On-demand deep critique call (phase 3).
- Score history, trends, or persistence of scores.
- Any change to the suggestions/rewrite endpoints.
