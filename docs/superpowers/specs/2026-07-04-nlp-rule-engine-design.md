# spaCy NLP layer and multi-language rule engine

## Context

The deterministic rule engine currently supports four regex-based check types and two
languages (EN, DE). Two limits motivate this change:

1. **Linguistic depth**: rules like passive-voice detection need tokenization, POS tags,
   and dependency parses — regex heuristics produce false positives and can't express
   syntax-level patterns.
2. **Language coverage**: Japanese and Chinese have no whitespace word boundaries; the
   current `\b`-regex matching, `[.!?]` sentence splitting, and word-count rules are
   structurally wrong for them.

Decision (user research + this design): **spaCy is the common abstraction layer** — one
API over per-language pipelines, with mature token (`Matcher`) and syntax
(`DependencyMatcher`) pattern engines. First expansion wave: **FR, ES, IT, JA, ZH**
(joining EN, DE). Rule formalism: **spaCy's native pattern syntax** embedded in the
existing YAML rule files (a friendlier custom DSL is a possible later addition, not part
of this design).

## A. NLP layer (`backend/app/nlp/`)

- `registry.py`: `NlpRegistry` maps `Language → spaCy pipeline`.
  - Default models: `en_core_web_sm`, `de_core_news_sm`, `fr_core_news_sm`,
    `es_core_news_sm`, `it_core_news_sm`, **`ja_ginza`**, `zh_core_web_sm`.
    Overridable per language in `config.yaml` (`nlp.models.<lang>`).
  - **Japanese: `ja_ginza` (GiNZA standard model, speed-oriented) is the default.**
    GiNZA builds on SudachiPy like spaCy's official model but parses Japanese markedly
    better and adds bunsetsu (文節) APIs and Sudachi normalized forms — both useful for
    Japanese rules and terminology. `ja_core_news_sm` is the documented lightweight
    fallback (one config line). **Accepted trade-off, to be documented in the README:**
    GiNZA's release cadence lags spaCy's (v5.2.0 pins spaCy 3.7), so GiNZA constrains
    the backend's spaCy version; if it ever blocks a needed upgrade, switch `ja` to the
    fallback model. `ja_ginza_electra` (transformer, ≥16 GB memory) is out of scope.
  - Pipelines load **lazily on first use**, thread-safe, with NER disabled for speed.
    Startup stays instant; the first check per language pays a 1–3 s load.
  - Missing model → language reported unavailable with an install hint; **NLP rules are
    skipped (and reported as skipped), regex rules keep working.**
- `analyze(text, language) -> Doc | None`: parses once per check run; all NLP rules and
  segmentation consumers share the same `Doc`.
- `scripts/install-models.py`: installs models for chosen languages (`spacy download`
  for official models, `pip install ginza ja_ginza` for Japanese). EN/DE/JA/ZH models
  are dev/test dependencies so tests run against real pipelines, not mocks.

## B. New rule types (native spaCy pattern syntax)

Same YAML files and loader as today; two new `extends` values:

```yaml
extends: token_pattern          # spaCy Matcher pattern
message: "Weak verb + nominalization — use the verb directly."
level: suggestion
category: style
pattern:
  - {LEMMA: make}
  - {POS: DET, OP: "?"}
  - {LOWER: {IN: [decision, assessment, assumption]}}
```

```yaml
extends: dependency             # spaCy DependencyMatcher pattern
message: "Passive voice — consider naming who acts."
level: suggestion
category: style
pattern:
  - {RIGHT_ID: verb, RIGHT_ATTRS: {TAG: VBN}}
  - {LEFT_ID: verb, REL_OP: ">", RIGHT_ID: aux, RIGHT_ATTRS: {DEP: auxpass}}
```

- Loader validates patterns at load time by compiling against a blank vocab (no model
  download needed); invalid patterns appear in `GET /api/rules` errors like YAML errors
  do today.
- Finding span = matched token range (for `dependency`: min/max offsets over matched
  tokens) mapped to character offsets — highlighting, LLM suggest-fix, and rewrite work
  unchanged.
- Optional static `suggestions` field supported as in other rule types.
- The EN regex passive-voice heuristic is **replaced** by a dependency rule; DE gets a
  `werden`+participle rule. These are the reference linguistic starter rules.

## C. Segmentation-aware core (the CJK fixes)

- **Sentence splitting** (`split_sentences` — used by `occurrence` scope and sentence
  rewrites): uses spaCy `doc.sents` when the language's pipeline is available; fallback
  regex extended with `。！？`. Same `(start, end, text)` contract.
- **Terminology matching**: for `ja`/`zh`, the checker matches via spaCy
  `PhraseMatcher` over tokens instead of `\b` regexes (which are meaningless in CJK);
  European languages keep the regex path. If the CJK model is missing, terminology
  falls back to plain substring search (documented limitation).
- **`occurrence` rules** gain `count: tokens` (spaCy token count per sentence) so
  long-sentence rules work where `\b\w+\b` cannot. Default remains `count: matches`
  (regex), fully backward compatible. Japanese may later use bunsetsu counts via GiNZA;
  starter rules use token counts.

## D. Language expansion

- `Language` enum → `en, de, fr, es, it, ja, zh` (backend pydantic + frontend TS union).
- New `GET /api/languages` → `[{code, name, nlp_available, model}]`; the frontend
  header and terminology selectors are driven by it and show a "basic checks only"
  hint when `nlp_available` is false.
- LLM prompt language names extended to all seven.
- Starter rule sets per new language, modest but real:
  - FR/ES/IT: fillers/weasel words (existence), clichés (existence), long sentence
    (occurrence), repeated words (repetition).
  - JA: long sentence via `count: tokens`; formal-stiffness/filler expressions
    (token_pattern); sentence splitting via `。`.
  - ZH: long sentence via `count: tokens`; filler/cliché expressions (token_pattern).
  - `repetition` stays European-only (whitespace-based by construction).

## E. Error handling summary

| Situation | Behavior |
|---|---|
| Model not installed | Language marked `nlp_available: false`; NLP rules skipped + reported; regex rules, terminology (regex/substring), LLM checks all still work |
| Invalid pattern YAML | Rule rejected at load, listed in `GET /api/rules` errors, engine unaffected |
| Pattern valid but attribute unknown at runtime | Caught per rule; rule reported as erroring, other rules unaffected |
| GiNZA/spaCy version conflict | Documented: pin spaCy to mutually supported version; fallback `ja_core_news_sm` |

## F. Testing

Real models (EN, DE, JA, ZH sm-tier as dev deps), no NLP mocks:

- `token_pattern` and `dependency` golden tests (EN passive: "The report was written by
  the team" flagged, "The team wrote the report" not — the regex heuristic's false
  positives become regression tests).
- JA: sentence splitting on `。`; token-count long-sentence rule; a GiNZA-tokenized
  terminology match.
- ZH: terminology `PhraseMatcher` match without whitespace.
- Pattern validation errors surface in `/api/rules`.
- Degradation: a test overrides the registry config to a nonexistent model name for one
  language and verifies regex rules still run while NLP rules are reported as skipped.
- Frontend: `Language` union/type updates compile; selector driven by `/api/languages`
  (vitest for the availability-hint logic).

## G. Implementation milestones

- **M1 — NLP core (EN/DE)**: `NlpRegistry`, `analyze`, the two rule types, loader
  validation, spaCy-backed `split_sentences`, EN/DE linguistic starter rules replacing
  the passive-voice regex, degradation path, model install script, README (incl. GiNZA
  trade-off note).
- **M2 — Languages**: enum + API + frontend expansion, `GET /api/languages`,
  terminology PhraseMatcher for CJK, `count: tokens`, starter rules + prompts for
  FR/ES/IT/JA/ZH, end-to-end verification incl. a Japanese demo text.

## Out of scope (explicitly)

- Friendlier custom rule DSL compiled to spaCy patterns (parked as future idea).
- `ja_ginza_electra` / transformer-tier models.
- Spellchecking, readability scores, additional languages beyond the seven.
- Bunsetsu-based Japanese readability rules (noted as future candidate once M2 lands).
