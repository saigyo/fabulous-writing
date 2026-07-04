# Deterministic vetting of LLM-generated suggestions

## Context

LLM findings already pass a deterministic gate (verbatim-quote anchoring; unanchorable
findings are discarded). LLM *suggestions* — inline suggestions on check findings,
on-demand suggest-fix, and sentence rewrites — have no gate at all, and sometimes the
model produces wrong or absurd fixes. Observed case (2026-07-04, claude-sonnet-5, DE):
for the `style.wuerde-stil` finding „würde Ihnen den Editor sofort empfehlen" it
suggested „empföhle Ihnen den Editor sofort" and „empfähle Ihnen den Editor sofort" —
grammatically attested but archaic forms nobody writes.

Two causes: (1) the prompts push the model to apply the rule message literally,
(2) nothing checks the output. This design fixes both.

**Verified premise** (pyspellchecker 0.9.0 frequency dictionaries): `empföhle`,
`empfähle` → unknown; `empfehle`, `empfehlen` → known; `recieve` → unknown (EN);
but `Basisversion` → unknown too, so a document-word whitelist is required to
protect proper nouns, product names, and German compounds the writer already uses.

## A. Prompt adjustments

`_SUGGESTION_SYSTEM_TEMPLATE` and `_REWRITE_SYSTEM_TEMPLATE` gain a rule:

- The issue description explains the *problem*; it is not a transformation recipe.
  Choose the most natural, contemporary wording a professional writer would use —
  rephrasing is allowed — and avoid archaic, stilted, or uncommon forms even if they
  are technically correct.

## B. Vetting pipeline (`backend/app/checkers/llm/vetting.py`)

`vet_suggestions(candidates, *, original, text, language, ...) -> VetResult` with
three deterministic stages. `VetResult` carries the accepted list and the rejected
count (for UI transparency).

1. **Sanity filters** (all scopes): non-empty; different from the flagged text;
   length ratio vs. original within [1/4, 4] (rewrites regularly shorten/split, so
   generous bounds); no leftover JSON/quote artifacts (leading/trailing `"`…`"`,
   `[`, `]`).
2. **Spell gate** (EN/DE/FR/ES/IT; skipped for JA/ZH where word-level spell checking
   is not meaningful): tokenize the candidate (`\w+`, unicode); drop tokens that
   contain digits or appear — case-insensitively — in the **whitelist** = all words
   of the user's document. Remaining tokens are looked up in the language's
   pyspellchecker frequency dictionary; any unknown word rejects the candidate.
   Dictionaries load lazily and are cached per language (module-level, thread-safe
   enough for our single-process server; loading is idempotent).
3. **Rule re-check** (on-demand suggestions/rewrites only, where we know the span):
   splice the candidate into the document, run the rule engine over before/after
   (with a spaCy parse when available so NLP rules participate) and compare
   per-rule-id finding counts:
   - any rule id with **more** findings after than before → reject (the fix
     introduces new problems);
   - if the request names the finding's `rule_id` (rule-sourced findings), that
     rule's count must **decrease** → otherwise the fix does not fix (also catches
     "replaced one weasel word with another").

Inline check-time suggestions (up to 15 findings × several candidates) get stages
1–2 only; the rule re-check with its parses stays on the cheap on-demand path.

## C. API and frontend

- `POST /api/suggestions` request gains optional `rule_id: str | null`; the frontend
  passes the finding's rule id. Response gains `rejected: int`. Vetting runs after
  JSON extraction; surviving suggestions are returned. All rejected → `suggestions: []`
  with `rejected > 0` (not an error; the LLM worked, its output didn't survive).
- `LLMChecker.check` vets each finding's `suggestions` with stages 1–2; findings stay
  even when all their suggestions are dropped (the diagnosis can be right while the
  fix is wrong).
- Frontend: when a suggest-fix/rewrite response has zero suggestions and
  `rejected > 0`, show "No reliable suggestion — N candidate(s) failed local checks."
  instead of nothing.
- `Settings.vet_suggestions: bool = True` — kill switch in `config.yaml`, applied to
  both paths.

## D. Error handling

| Situation | Behavior |
|---|---|
| Dictionary missing/unloadable for a language | Spell gate skips (log-free, degrade open) — never blocks suggestions |
| JA/ZH | Spell gate skipped by design; sanity filters + rule re-check still run |
| All candidates rejected | 200 with empty list + rejected count; UI explains |
| Vetting disabled via config | Raw behavior as before |

## E. Testing

- Unit tests per stage; **regression test for the observed case**: candidates
  `["empföhle Ihnen den Editor sofort", "empfähle Ihnen den Editor sofort"]` for a
  DE text containing „würde Ihnen den Editor sofort empfehlen" → both rejected;
  `["Ich empfehle Ihnen den Editor."]` → accepted.
- Whitelist test: candidate reusing a rare document word (`Basisversion`) passes.
- Rule re-check tests: fix leaving the rule firing → rejected; fix introducing a
  repeated word → rejected; genuine fix → accepted.
- API tests with FakeProvider returning poisoned candidates; checker test that inline
  suggestions are filtered but the finding survives.
- Frontend vitest for the empty+rejected message path.

## F. Milestones

- **M1 — Vetting gate (this design):** prompts, vetting module (sanity + spell gate +
  rule re-check), API/checker wiring, config flag, frontend messaging, tests incl.
  the screenshot regression.
- **M2 — Morphology-aware spelling (delivered 2026-07-04):** Hunspell dictionaries
  via [spylls](https://github.com/zverok/spylls) as a **union gate**: a
  frequency-unknown word is rescued when the language's dictionary knows it (affix
  forms, German compounds). Not a replacement — igerman98 happens to exclude
  empföhle/empfähle so the regression holds, but the frequency list stays as the
  baseline and for languages without an installed dictionary. Simplifications vs.
  the original sketch: one `dictionaries_dir` setting with a `<lang>.aff/.dic`
  convention (instead of per-language paths); dictionaries downloaded on demand by
  `scripts/install-dictionaries.sh` (own licenses, not bundled). Benchmark
  (`scripts/vetting-benchmark.py`, demo texts, empty whitelist): false rejects
  ES 12→1, IT 6→1, FR 2→0; all planted errors still caught. Parked: LanguageTool
  as an optional grammar-level gate.

## Out of scope

- Spell-checking the *user's* text (findings) — this design only vets LLM output.
- LLM-as-judge second-pass verification (non-deterministic; parked).
- CJK suggestion vetting beyond sanity + rule re-check.
