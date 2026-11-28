# Terminology T2, Pull Request 1: Matching and Editor Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A writer can switch on, per term, the matching of inflected forms (six languages) and of German compounds; the term editor suggests the part of speech and tests the term on its example sentence; a base-form suggestion is marked as such and offers "Suggest fix".

**Architecture:** Exact and casing matching stay untouched. Two further passes run only for terms with a switch on: a base-form pass that walks the analysed document once through the token matcher Japanese and Chinese already use, and a compound pass that confirms German compounds with the Hunspell dictionary. One object per request hands the same analysed document to the rules checker and the terminology checker. A stateless endpoint analyses a term draft for the editor.

**Tech Stack:** Python 3, FastAPI, Pydantic v2, spaCy pipelines through `NlpRegistry`, `spylls` Hunspell dictionaries, SQLite and Postgres through the shared database seam, pytest. React 19, TypeScript, zustand, vitest with Testing Library, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-28-terminology-t2-morphology-design.md`, sections 5, 6, 7.4, 7.5, 8, 9 and 13. Sections 7.1 to 7.3 belong to the second pull request and its own plan. Executors read both documents.

## Global Constraints

- **Branch:** all work on `terminology-t2-pr1-matching`, created from `main` after the spec and this plan are merged. Never commit to `main`.
- **Unchanged behaviour.** `backend/tests/data/terminology_baseline.json` is not edited and `tests/test_terminology_baseline.py` stays green in every commit. A term with neither switch on gives exactly today's findings, messages and order. `_check_regex`, `_casing_regex`, `_check_substring` and `_casing_substring` keep their behaviour.
- **No new dependency.** `pyproject.toml`, `uv.lock` and `THIRD-PARTY-NOTICES.md` do not change. If a task seems to need a package, stop: the plan is wrong.
- **Nothing under `clients/` changes.**
- **Additive API only.** `Finding`, `ConceptTerm` and `TermInput` gain fields with defaults; no field is renamed or removed.
- **Commit trailer on every commit:** `Co-Authored-By: <model> <noreply@anthropic.com>`, naming the model that makes the commit.
- **Backend commands** run from `backend/` with `rtk proxy uv run …`; **frontend commands** from `frontend/` with `rtk proxy npm …`. The shell's working directory is reset between calls: put `cd /Users/markus/IdeaProjects/fabulous-writing/<dir> && …` in the same command. `ruff` is not installed locally.
- **Backend gate (Tasks 1 to 6, 9):** `rtk proxy uv run pytest -q` green with zero warnings, once without and once with the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (the controller confirms the local stack is up before Task 1).
- **Frontend gate (Tasks 7 and 8):** `rtk proxy npm test`, `rtk proxy npm run lint` and `rtk proxy npm run build` all green; lint adds no new warning.
- **Mutation-verify every new behaviour test:** change the rule it pins, watch the test fail, restore by re-editing the file (never `git checkout <file>`, never a scripted text replacement). A test that asserts on rendered output must wait for the render (`findBy…`/`waitFor`) before asserting. State in the task report which mutation was run and how the test failed.
- **Language models and dictionaries** are installed locally and in CI (`scripts/install-models.sh`, `scripts/install-dictionaries.sh`). Tests that need them are not marked or skipped, as in `tests/test_nlp_rules.py`. Every test module that loads pipelines gets them from one session-scoped fixture (Task 2), never from a registry of its own.
- **Suite runtime:** the controller records the backend suite time (about 19 s on SQLite) and the `npm test` time before Task 1. Report a task that adds more than 2 s to either. The whole pull request may add at most 10 % to the backend suite without a stated reason.
- **User-facing text** is added to `frontend/src/i18n/messages.ts` and all seven catalogs (`en`, `de`, `es`, `fr`, `it`, `ja`, `zh`) in the same commit, in the informal register (`register.test.ts`). The English texts are given in Tasks 7 and 8, verbatim.
- **Backend messages are English**, as today. Their texts are fixed in "Readings" below; tests compare whole messages.
- **No comments that retell the code.** Prefer the simplest correct solution.
- **Ports 5173 and 8000** belong to the owner's dev servers. Never start, stop or bind anything there. Never touch `backend/data/fabulous.db` or `backend/config.yaml`.
- **No live LLM call without the owner's cue** (Task 8, Step 1).

## Review Focus

Conditions the spec implies but does not spell out as tests. Each has its test in the task named.

1. **Text with repeated spaces, line breaks or emoji before an inflected hit.** The finding's span must still point at the hit in the original text. Task 3.
2. **A switch is on but the language model or the German dictionary is missing.** The check must not fail; exact matching works; the term check reports `no_model` or `no_dictionary`. Tasks 3, 5 and 6.
3. **A term made of symbols or containing regular-expression characters ("C++", "a.b", "(x)") with both switches on.** No exception, and no finding beyond what the exact pass gives. Tasks 3 and 5.
4. **Oversized or hostile input to the term check:** a 10,000-character term or example, an unknown language, no session. The endpoint answers 422 or 401 and analyses nothing. Task 6.
5. **Fast typing in the editor.** An answer for an older draft that arrives after a newer one must not be shown. Task 7.

## Readings of the spec that this plan fixes

A reviewer checks the code against these, not against a different reading.

1. **Qualifying term.** Enforced (`is_enforced`), usage status forbidden or deprecated, and the switch for the pass is on. The base-form pass runs for `en`, `de`, `fr`, `es`, `it`, `ja`; the compound pass for `de` only, and only for terms whose text contains no whitespace and no hyphen.
2. **Base-form sequences of a term** (spec 6.3), each a tuple of case-folded strings, duplicates removed:
   - *written*: the texts of the term's tokens (`make_doc`);
   - *lone*: the base forms of the term analysed on its own (full pipeline for the western languages, tokenizer for Japanese). Dropped when the term has a part of speech and the head of that analysis does not fit it by the table in Reading 5;
   - *example*: if the term's written tokens occur in its `context` (token-aligned, case-insensitive), the base forms of that occurrence in the analysed `context`.
3. **Base-form hit.** The document's base forms, case-folded, contain one of the term's sequences as a run of whole tokens. The hit's text and offsets are those of the original tokens.
4. **Case rule.** For a term with `case_sensitive`, the first character of the hit must equal the first character of the term's text; if the term starts with a lower-case letter, a hit that starts with its upper-case form at a sentence start (`_sentence_start`) is accepted too. Without `case_sensitive` there is no case condition.
5. **Part-of-speech limit.** Applied only when the term has a part of speech other than `other`. The head of the hit is `span.root` for the western languages and the last token for Japanese.

   | Term's part of speech | Accepted `pos_` of the head |
   |---|---|
   | `noun`, `proper_noun` | `NOUN`, `PROPN` |
   | `verb` | `VERB`, `AUX` |
   | `adjective` | `ADJ`; for German also `ADV` |
   | `adverb` | `ADV` |

   The reverse mapping, used by the term check: `NOUN`→noun, `PROPN`→proper_noun, `VERB` and `AUX`→verb, `ADJ`→adjective, `ADV`→adverb, anything else→other.
6. **Accepted wordings.** Built once per `check()` call from all sections of the domain in the language: the texts of enforced preferred and admitted terms. A base-form or compound hit is dropped when its text equals one of them, compared case-folded for a term without `case_sensitive` and exactly for a term with it.
7. **Message of a base-form finding:** as a status finding today (plan T1-PR2, Reading 4), with `M` the hit's text.
8. **`suggestions_base_form`** is true exactly when the finding comes from the base-form pass, has at least one suggestion, and the hit's text differs from the matched term's text after case-folding. It is false for every exact, casing and compound finding.
9. **Compound candidate.** A maximal run of letters in the text (`[^\W\d_]+`), so the parts of a hyphenated word are separate candidates. It is tested as written and, when an analysed document already exists for the request, also in the base form of the token that starts at the same offset and has the same text. An analysis is never requested for the compound pass alone.
10. **Compound rule** (spec 6.5), on the lower-cased candidate `w` and term `t`, for every occurrence of a stem `s` in `w` with `w != s`. The stems are `t` and, if `t` ends in "e" and has more than four letters, `t` without that "e". With `before` and `after` the rest of `w` on each side:
    - `before` is empty, or `before` minus a linking element at its end is a word;
    - `after` is empty, or is a linking element, or `after` minus a linking element at its start is a word;
    - at least one side is a word in that sense;
    - for the shortened stem, `after` must be a word in that sense.

    Linking elements: `""`, `"s"`, `"es"`, `"n"`, `"en"`, `"e"`, `"er"`, `"ens"`. A part is a word when it has at least three letters and `dictionary.lookup(part.capitalize())` is true.
11. **Message of a compound finding,** parts joined by one space: `'W' contains 'T'.`; with replacements `Use 'A' instead.` or `Use 'A' or 'B' instead.`; the term's `status_reason` if not empty; the section's definition if not empty. `W` is the candidate as written, `T` the term's text. `suggestions` is empty. The span is the candidate.
12. **Overlaps within a domain.** Every status finding has a pass rank: exact 0, base form 1, compound 2. In this order:
    - for the same term (same `rule_id`), a finding is dropped when it overlaps a finding of lower rank;
    - a warning that overlaps an error is dropped (as today);
    - of two overlapping findings with the same severity, the one with the higher rank is dropped; with the same rank both are kept (as today);
    - a casing finding that overlaps any kept status finding is dropped (as today).
13. **When an analysis is requested.** Never for Japanese or Chinese. For the western languages only when the rules checker runs, or when a selected domain has a qualifying term for the base-form pass in the language. At most once per request.
14. **Missing pipeline or dictionary.** The pass is skipped silently. Nothing is added to `skipped_rules`.
15. **Term check, example sentence.** The draft is matched against `context` with all three passes, both switches treated as on, without the part-of-speech limit, the case rule and accepted wordings. The first hit by offset is reported: `matched` its text, `part_of_speech` the head's tag by the reverse mapping of Reading 5, `base_form` the base forms of the hit's tokens (`lemma_`, as the pipeline gives them) joined by spaces. A compound hit reports `part_of_speech` noun and the candidate as `base_form`.
16. **Term check, `recognised` and `needs_example`.** `recognised` lists, in this order: the part of speech found in the example sentence (source `example`); the parts of speech the dictionary lists for a one-token term (source `dictionary`); for a term of several tokens, and for a one-token German or Italian term if the language is in `LONE_READING_LANGUAGES`, the part of speech of the lone analysis' head (source `phrase`). `needs_example` is true unless `recognised` holds an entry with source `dictionary` or `example`.
17. **Term check, `base_form`.** English, French, Spanish: set when no part-of-speech set of `lemma_index` contains the lower-cased term and the lone analysis gives a base form that one of them contains. Japanese: set when the term is one token and that token's base form differs from the term. German and Italian: only if the language is in `LONE_READING_LANGUAGES` (Task 6), from the lone analysis. Never for a term of several tokens.
18. **The field `replacement`** of the term check (spec 8.1) is not part of this pull request.

## What the second pull request needs from this one

- `Finding.suggestions_base_form` and the sidebar that honours it.
- `term_forms.analyse_lone(nlp, language, text)` for the head and part of speech of a replacement.
- The base-form pass as the single place where a finding for an inflected hit is built (`_base_form_finding`), so that a generated form replaces the base form there.

## File Structure

| File | Change |
|---|---|
| `backend/app/services/terminology/schema.py` | Two columns on `concept_terms`; `TERM_COLUMNS`; `REQUIRED_SCHEMA`. |
| `backend/app/services/terminology/store.py` | Calls `migrate_columns` for `concept_terms`. |
| `backend/app/services/terminology/model.py` | `match_inflections`, `match_compounds` on `ConceptTerm` and `TermInput`. |
| `backend/app/services/terminology/changes.py`, `rows.py` | The two fields in `TERM_FIELDS` and `_term_from_row`. |
| `backend/app/core/models.py` | `Finding.suggestions_base_form`. |
| `backend/app/nlp/analysis.py` | New. `TextAnalysis`: one tokenized and one analysed document per request. |
| `backend/app/nlp/dictionaries.py` | New. The Hunspell cache moved out of `vetting.py`. |
| `backend/app/checkers/token_matching.py` | New. `phrase_matches`, the shared token matcher. |
| `backend/app/checkers/term_forms.py` | New. Base-form sequences of a term, their cache, part-of-speech mapping. |
| `backend/app/checkers/compounds.py` | New. The compound rule as pure functions. |
| `backend/app/checkers/terminology.py` | The two new passes, accepted wordings, overlap ranks. |
| `backend/app/checkers/term_check.py` | New. Analysis of a term draft. |
| `backend/app/api/terminology.py` | `POST /api/terminology/term-check`. |
| `backend/app/api/checks.py` | One `TextAnalysis` per request. |
| `backend/app/checkers/llm/vetting.py` | Imports the Hunspell cache from its new place. |
| `backend/scripts/measure_terminology_check.py` | New. Latency table for the pull request. |
| `backend/tests/conftest.py` | Session fixture `nlp_registry`. |
| `backend/tests/test_terminology_inflections.py`, `test_terminology_compounds.py`, `test_term_check.py`, `test_token_matching.py`, `test_text_analysis.py` | New. |
| `backend/tests/data/compound_pairs.json`, `lone_reading_de.json`, `lone_reading_it.json` | New test data. |
| `frontend/src/types.ts`, `api/client.ts` | New fields and the term-check call. |
| `frontend/src/terminology/conceptDraft.ts` | The two fields in the draft. |
| `frontend/src/terminology/termCheck.ts`, `useTermCheck.ts`, `TermCheckNotes.tsx` | New. Messages, the debounced call, the display. |
| `frontend/src/terminology/LanguageSectionEditor.tsx` | Switches, notes, relabelled example field. |
| `frontend/src/findings/suggestions.ts`, `frontend/src/sidebar/Sidebar.tsx` | Base-form note and "Suggest fix" next to base-form suggestions. |
| `frontend/src/i18n/messages.ts` and the seven catalogs | New texts. |
| `docs/backend-architecture.md`, `docs/frontend-architecture.md` | Task 9. |
| `docs/LOGBOOK.md` | Entry for this pull request, last commit, on the owner's cue. |

---

### Task 1: The two switches in the store and the API

**Files:**
- Modify: `backend/app/services/terminology/schema.py`, `store.py`, `model.py`, `changes.py`, `rows.py`
- Test: `backend/tests/test_terminology_store.py`, `test_terminology_changes.py`, `test_terminology_transfer.py`, `test_concept_api.py`, `test_manage_schema.py`

**Interfaces:**
- Produces: `ConceptTerm.match_inflections: bool = False`, `ConceptTerm.match_compounds: bool = False`, the same two on `TermInput`, copied by `TermInput.from_term`.
- Produces: `schema.TERM_COLUMNS = [("match_inflections", "INTEGER NOT NULL DEFAULT 0"), ("match_compounds", "INTEGER NOT NULL DEFAULT 0")]`; `REQUIRED_SCHEMA["concept_terms"] = TERM_COLUMNS`.

- [ ] **Step 1: Write the failing tests.** All store tests use the `db` fixture and run on both backends.
  - `test_switches_are_stored_and_returned`: a term created with `match_inflections=True, match_compounds=True` reads back with both true; a term created without them reads back with both false.
  - `test_switch_change_is_logged`: saving a section with `match_inflections` flipped writes one `edited` entry for that term whose changes are `[{"field": "match_inflections", "old": False, "new": True}]` (the shape `case_sensitive` produces today; copy the assertion style of the existing `case_sensitive` test in `test_terminology_changes.py`).
  - `test_move_and_merge_keep_the_switches`: a term with both switches on is moved to another concept, and a concept holding such a term is merged into another; in both results the term still has both switches on.
  - `test_existing_database_gains_the_columns`: create `concept_terms` without the two columns (run `SCHEMA` and drop them, or create the table from the T1 column list), construct `TerminologyStore(db)`, and read a term: both false.
  - In `test_manage_schema.py`: with `manage_schema=False` and the columns missing, construction raises `RuntimeError` naming `concept_terms.match_inflections`.
  - In `test_concept_api.py`: `PUT /api/concepts/{id}/languages/de` with a term carrying both fields returns them; a body without them returns false for both.
- [ ] **Step 2: Run** `rtk proxy uv run pytest -q tests/test_terminology_store.py tests/test_terminology_changes.py tests/test_terminology_transfer.py tests/test_concept_api.py tests/test_manage_schema.py`. Expected: the new tests fail on the unknown field or column.
- [ ] **Step 3: Implement.** Add the columns to the `concept_terms` statement in `SCHEMA` and to `TERM_COLUMNS`; in `TerminologyStore.__init__` call `migrate_columns(conn, "concept_terms", schema.TERM_COLUMNS)` after `executescript` when `manage_schema` is true. Append both names to `TERM_FIELDS` in `changes.py` (rows.py writes and compares through it) and read them in `_term_from_row` with `bool(...)`.
- [ ] **Step 4: Run the backend gate** on both backends. Expected: green, baseline test included.
- [ ] **Step 5:** Mutation-verify the `migrate_columns` call and the `from_term` copy.
- [ ] **Step 6: Commit** `feat(terminology): per-term switches for inflected forms and compounds`.

---

### Task 2: One analysis per request and the shared token matcher

No behaviour changes in this task.

**Files:**
- Create: `backend/app/nlp/analysis.py`, `backend/app/checkers/token_matching.py`
- Modify: `backend/app/checkers/terminology.py`, `backend/app/api/checks.py`, `backend/tests/conftest.py`
- Test: `backend/tests/test_text_analysis.py`, `backend/tests/test_token_matching.py`, `backend/tests/test_check_api.py`

**Interfaces:**
- Produces, in `app/nlp/analysis.py`:

```python
class TextAnalysis:
    def __init__(self, nlp: "NlpRegistry | None", text: str, language: Language) -> None: ...
    text: str
    language: Language
    def pipeline(self) -> Any | None      # nlp.get(language.value); None without registry or model
    def tokens(self) -> Any | None        # pipeline.make_doc(text), built once
    def analysed(self) -> Any | None      # nlp.analyze(text, language.value), requested at most once
    def analysed_if_ready(self) -> Any | None   # the analysed document if analysed() already ran, else None
```

- Produces, in `app/checkers/token_matching.py`:

```python
def phrase_matches(vocab: Any, haystack: Any, needles: Sequence[Any], attr: str) -> list[tuple[int, int, int]]:
    """(index into needles, start token, end token) for every occurrence, from one PhraseMatcher pass."""
```

- Produces: `TerminologyChecker.check(text, language, domain_id, *, owner_id, analysis: TextAnalysis | None = None)`. Without `analysis` the checker builds its own from `self.nlp`.
- Produces for tests, in `tests/conftest.py`: `@pytest.fixture(scope="session") def nlp_registry() -> NlpRegistry` returning `NlpRegistry(NlpSettings().models)`.

- [ ] **Step 1: Write the failing tests.**
  - `test_token_matching.py::test_phrase_matches_reports_every_needle`: with the `ja` pipeline, haystack `make_doc("サーバとサーバーを再起動する。")`, needles for "サーバー" and "再起動", attribute `"ORTH"`: result is `[(0, 2, 3), (1, 4, 5)]` after sorting.
  - `test_text_analysis.py::test_analysed_is_requested_once`: a registry stub that counts `analyze` calls; `analysed()` called three times gives one call and the same object. `test_analysed_if_ready`: `None` before `analysed()`, the document after. `test_without_registry`: all four methods return `None`.
  - `test_check_api.py::test_rules_and_terminology_share_one_analysis`: `app.state.nlp.analyze` wrapped by a counter; a check with `checkers=["rules", "terminology"]`, two domain ids and language `en` calls it once. `test_terminology_alone_requests_no_analysis`: with `checkers=["terminology"]` it is not called.
- [ ] **Step 2: Run** the three files. Expected: import errors for the new modules; the shared-analysis test fails with a count of one already (rules only) or passes. State which.
- [ ] **Step 3: Implement** `TextAnalysis` and `phrase_matches`. `_check_cjk` and `_casing_cjk` call `phrase_matches` and take their document from `analysis.tokens()`; their results must not change. `create_check` builds one `TextAnalysis(app.state.nlp, body.text, body.language)`, passes `analysis.analysed()` to the rule engine and `analysis` to every `checker.check` call.
- [ ] **Step 4: Run the backend gate** on both backends. Expected: green; `tests/test_terminology.py` (Japanese and Chinese paths) and the baseline unchanged.
- [ ] **Step 5:** Mutation-verify the memoisation in `analysed()` (the count test fails with two calls).
- [ ] **Step 6: Commit** `refactor(terminology): shared token matcher and one text analysis per request`.

---

### Task 3: Base-form pass

**Files:**
- Create: `backend/app/checkers/term_forms.py`
- Modify: `backend/app/checkers/terminology.py`, `backend/app/core/models.py`
- Test: `backend/tests/test_terminology_inflections.py`, `backend/tests/test_models.py`

**Interfaces:**
- Consumes: `TextAnalysis`, `phrase_matches`, `nlp_registry` from Task 2; the switches from Task 1.
- Produces: `Finding.suggestions_base_form: bool = False`.
- Produces, in `app/checkers/term_forms.py`:

```python
INFLECTION_LANGUAGES: frozenset[Language]   # en, de, fr, es, it, ja
POS_TAGS: dict[PartOfSpeech, frozenset[str]]            # Reading 5, without the German exception
def accepts_pos(part_of_speech: PartOfSpeech | None, tag: str, language: Language) -> bool
def part_of_speech_of(tag: str) -> PartOfSpeech          # reverse mapping of Reading 5
def head(span: Any, language: Language) -> Any           # span.root, or span[-1] for Japanese

@dataclass(frozen=True)
class LoneAnalysis:
    base_forms: tuple[str, ...]      # case-folded, one per token
    head_tag: str                    # pos_ of the head
def analyse_lone(nlp: "NlpRegistry", language: Language, text: str) -> LoneAnalysis | None   # None without pipeline

class TermFormsCache:
    def __init__(self, max_entries: int = 50_000) -> None: ...
    def sequences(self, nlp: "NlpRegistry", language: Language, term: ConceptTerm) -> tuple[tuple[str, ...], ...]
```

  `sequences` returns Reading 2's sequences (empty without a pipeline). Key: `(language, nlp.model_name(language.value), term.text, term.context, term.part_of_speech)`. Least recently used entries are evicted; access is guarded by a lock. One module-level instance `TERM_FORMS = TermFormsCache()` is what the checker uses.
- Produces, in the checker: `_Entry.inflected: list[ConceptTerm]` (the reported terms that qualify, Reading 1) and `_base_form_finding(entry, term, span) -> Finding`, the only place that builds a finding for a base-form hit.

- [ ] **Step 1: Write the failing tests** in `test_terminology_inflections.py`, with the `nlp_registry` fixture and `add_concept` from `tests/terminology_helpers.py`. One parametrised test `test_inflected_forms_are_found` over this table; each row creates a forbidden term with `match_inflections=True` and a preferred term, and asserts the texts of the findings.

  | Language | Forbidden | Preferred | Text | Expected hit texts |
  |---|---|---|---|---|
  | en | file | document | "We opened two files." | ["files"] |
  | en | part of speech | word class | "All parts of speech are listed." | ["parts of speech"] |
  | en | log in | sign in | "She logged in yesterday." | ["logged in"] |
  | de | Datei | Dokument | "Wir prüfen die Dateien." | ["Dateien"] |
  | de | virtuelle Maschine | VM | "Wir starten die virtuellen Maschinen." | ["virtuellen Maschinen"] |
  | fr | machine virtuelle | VM | "Nous lançons des machines virtuelles." | ["machines virtuelles"] |
  | es | correo electrónico | mensaje | "Envíe los correos electrónicos." | ["correos electrónicos"] |
  | it | applicazione | app | "Abbiamo due applicazioni." | ["applicazioni"] |
  | ja | 読み込む | ロードする | "設定を読み込みました。" | ["読み込み"] |
  | ja | 美しい | きれい | "データが美しくなかった。" | ["美しく"] |

  Further tests:
  - `test_switch_off_finds_nothing`: the German row with `match_inflections=False` gives no finding.
  - `test_message_severity_and_flag`: German row: message `Use 'Dokument' instead of 'Dateien'.`, `Severity.ERROR`, `suggestions == ["Dokument"]`, `suggestions_base_form is True`, `rule_id == f"terminology.{uid of 'Datei'}"`. With the term deprecated: `Severity.WARNING`.
  - `test_base_form_hit_is_left_to_the_exact_pass`: text "Die Datei fehlt." gives one finding with `suggestions_base_form is False`.
  - `test_no_suggestion_no_flag`: a forbidden term without preferred or admitted term: the inflected hit has `suggestions == []` and `suggestions_base_form is False`.
  - `test_candidate_and_preferred_terms_are_not_matched`: a candidate forbidden term and a preferred term, both with the switch on, give no base-form finding.
  - `test_span_survives_irregular_whitespace` (Review Focus 1): text `"Erstens:  \n\n🙂 Wir prüfen   die Dateien."`; the finding's `span.text == "Dateien"` and `text[span.start:span.end] == "Dateien"`.
  - `test_missing_model_keeps_exact_matching` (Review Focus 2): `NlpRegistry({"de": "xx_bogus_model"})`; "Die Datei und die Dateien." gives exactly the exact finding for "Datei" and raises nothing.
  - `test_symbol_terms_do_not_break_the_pass` (Review Focus 3): forbidden terms "C++", "a.b" and "(x)" with the switch on, text "Wir nutzen C++ und a.b und (x)."; no exception; the findings equal those with the switch off.
  - `test_no_analysis_without_qualifying_term`: registry stub counting `analyze`; a German domain whose terms all have the switch off, `checkers` terminology only: zero calls. With one qualifying term: one call for two domains.
  - `test_example_sentence_supplies_base_forms`: Spanish noun "cuenta", part of speech noun, `context="La cuenta está bloqueada."`, forbidden with the switch on, preferred "perfil"; "Las cuentas están bloqueadas." gives the hit "cuentas"; "Contamos los archivos." gives no finding.
  - `test_cache_is_bounded`: `TermFormsCache(max_entries=2)` asked for three terms holds two entries, and the first is analysed again when asked a second time (count through a registry stub).
  - In `test_models.py`: `Finding` serialises `suggestions_base_form` and defaults it to false.
- [ ] **Step 2: Run** `rtk proxy uv run pytest -q tests/test_terminology_inflections.py`. Expected: fail on the missing module.
- [ ] **Step 3: Implement `term_forms.py`.** For the western languages `analyse_lone` runs `nlp.analyze`; for Japanese `nlp.get("ja").make_doc`. The *example* sequence is found with `phrase_matches(..., "LOWER")` of the written tokens in the tokenized `context`, and read from the analysed `context` at the same token range.
- [ ] **Step 4: Implement the pass in the checker.** The document is `analysis.tokens()` for Japanese and `analysis.analysed()` otherwise; without it the pass returns nothing. The comparison reuses the token matcher on a document of base forms:

```python
lemmas = Doc(vocab, words=[t.lemma_ or t.text for t in doc])           # same token count as doc
needles = [Doc(vocab, words=list(seq)) for seq in sequences]           # one per sequence, mapped back to its term
hits = phrase_matches(vocab, lemmas, needles, "LOWER")                 # token ranges are valid in doc
```

  A hit becomes `doc[start:end]`; its text and character offsets come from there. `check()` requests the analysis only when `entries` holds an inflected term (Reading 13). A base-form hit that overlaps an exact finding of the same term is dropped here already (first bullet of Reading 12); the other bullets and the pass ranks come with Task 4, until then base-form findings join the status findings in `_resolve_overlaps` as they are.
- [ ] **Step 5: Run the backend gate** on both backends. Expected: green, baseline unchanged.
- [ ] **Step 6:** Mutation-verify: the switch condition; the `suggestions_base_form` condition (make it always true and watch `test_base_form_hit_is_left_to_the_exact_pass` fail); the skip without a qualifying term; the cache bound.
- [ ] **Step 7: Commit** `feat(terminology): match inflected forms of switched-on terms`.

---

### Task 4: Limits and overlaps of the base-form pass

**Files:**
- Modify: `backend/app/checkers/terminology.py`
- Test: `backend/tests/test_terminology_inflections.py`

**Interfaces:**
- Consumes: `accepts_pos`, `head` from Task 3.
- Produces, in the checker: `_accepted(sections) -> tuple[frozenset[str], frozenset[str]]` (case-folded texts of accepted terms without `case_sensitive`; exact texts of those with it) and `_resolve_overlaps(status: list[tuple[Finding, int]], casing: list[Finding]) -> list[Finding]`, where the integer is the pass rank of Reading 12. Task 5 passes rank 2.

- [ ] **Step 1: Write the failing tests.**
  - `test_part_of_speech_limits_hits`: English forbidden "file", part of speech noun, switch on. "She filed the report." gives nothing; "She lost the files." gives "files". With part of speech `None` both sentences give a hit. With `other` both give a hit.
  - `test_german_adjective_accepts_adverb_tag`: forbidden "fertig", part of speech adjective; "Die Berichte sind fertig." and "die fertigen Berichte" each give one finding.
  - `test_head_of_a_multi_word_hit_decides`: English forbidden "log in", part of speech verb; "She logged in." gives a hit.
  - `test_case_sensitive_term`: German forbidden "Bug" with `case_sensitive=True` and no part of speech; "Wir beheben die Bugs." gives "Bugs"; "wir beheben die bugs" gives nothing. With the term "bug" instead: "Bugs treten auf." (sentence start) gives "Bugs"; "Die Bugs treten auf." gives nothing.
  - `test_accepted_wording_is_not_reported`: German forbidden "Datum" with the switch on in one concept, preferred "Daten" in another concept of the same domain; "Die Daten fehlen." gives nothing. Without the second concept the same text gives the hit "Daten" (the pipeline reads "Daten" as a form of "Datum").
  - `test_accepted_wording_respects_case_sensitivity`: the accepted term "Daten" with `case_sensitive=True` does not excuse "daten".
  - `test_exact_hit_of_another_term_wins`: forbidden "Datei" (switch on, replacement "Dokument") and, in another concept, forbidden "Dateien" (exact, replacement "Unterlagen"); "Die Dateien fehlen." gives one finding, for "Dateien" the term.
  - `test_error_beats_warning_across_passes`: deprecated "Dateien" exact and forbidden "Datei" with the switch on: one finding, the error from the base-form pass.
  - `test_two_base_form_hits_of_equal_severity_are_kept`: German forbidden "virtuelle Maschine" and forbidden "Maschine", both with the switch on; "Wir starten die virtuellen Maschinen." gives two findings, "virtuellen Maschinen" and "Maschinen".
- [ ] **Step 2: Run them.** Expected: fail (the limit, the case rule and the accepted set do not exist; the overlap tests give two findings).
- [ ] **Step 3: Implement** the three hit filters in the base-form pass and the ranks in `_resolve_overlaps`. The exact and casing passes keep their per-section `accepted` set.
- [ ] **Step 4: Run the backend gate** on both backends.
- [ ] **Step 5:** Mutation-verify each filter and each of the four bullets of Reading 12.
- [ ] **Step 6: Commit** `feat(terminology): part of speech, case and overlap rules for inflected hits`.

---

### Task 5: German compounds

**Files:**
- Create: `backend/app/nlp/dictionaries.py`, `backend/app/checkers/compounds.py`, `backend/tests/data/compound_pairs.json`
- Modify: `backend/app/checkers/terminology.py`, `backend/app/checkers/llm/vetting.py`, `backend/app/api/checks.py`
- Test: `backend/tests/test_terminology_compounds.py`, `backend/tests/test_vetting.py`

**Interfaces:**
- Consumes: `_accepted`, `_resolve_overlaps` with rank 2 from Task 4; `TextAnalysis.analysed_if_ready` from Task 2.
- Produces, in `app/nlp/dictionaries.py`: `def hunspell(code: str, dictionaries_dir: Path | None) -> Any | None`, the function and cache moved unchanged from `vetting._hunspell`.
- Produces, in `app/checkers/compounds.py`:

```python
LINKING_ELEMENTS: tuple[str, ...]     # Reading 10
def is_word(dictionary: Any) -> Callable[[str], bool]
def is_compound_of(term: str, word: str, word_test: Callable[[str], bool]) -> bool    # Reading 10
```

- Produces: `TerminologyChecker(store, nlp=None, dictionaries_dir: Path | None = None)`; `create_check` passes `app.state.settings.dictionaries_dir`.

- [ ] **Step 1: Write the test data.** `compound_pairs.json` is a list of objects `{"term", "word", "compound", "rule"}`: the 102 pairs of the spec's appendix, `compound` the expected truth and `rule` what the rule answers. `rule` differs from `compound` for exactly these seven: Staub/Staubecken, Drucker/Druckerzeugnis, Ende/Legende, Gabe/Aufgabe, Gang/Eingang, Sicht/Übersicht, Schlag/Vorschlag.
- [ ] **Step 2: Write the failing tests.**
  - `test_rule_on_the_measured_pairs`: for every pair, `is_compound_of(term, word, is_word(hunspell("de", dictionaries_dir)))` equals `rule`. A second assertion counts the pairs where `rule != compound`: exactly 7.
  - `test_compound_finding`: German forbidden "Handy" with `match_compounds=True`, preferred "Mobiltelefon", reason "Umgangssprache.", definition "Tragbares Telefon."; text "Der Handyvertrag läuft aus." gives one finding with span text "Handyvertrag", message `'Handyvertrag' contains 'Handy'. Use 'Mobiltelefon' instead. Umgangssprache. Tragbares Telefon.`, `suggestions == []`, `suggestions_base_form is False`, `Severity.ERROR`, `rule_id` of "Handy". Without a replacement the message is `'Handyvertrag' contains 'Handy'.`.
  - `test_hyphen_parts_are_candidates`: "Der Premium-Handyvertrag" gives the span "Handyvertrag"; "Der Handy-Vertrag" gives only the exact finding for "Handy".
  - `test_middle_part_and_inflected_compound`: forbidden "Speicher": "Arbeitsspeicherverwaltung" is found; forbidden "Datei": "Konfigurationsdateien" is found.
  - `test_plain_inflection_is_not_a_compound`: forbidden "Datei" with only `match_compounds`: "Dateien" gives nothing.
  - `test_switch_language_and_shape`: nothing is found with the switch off; for an English term with the switch on; for the German multi-word term "virtuelle Maschine"; for a term with a hyphen.
  - `test_accepted_compound_is_not_reported`: preferred "Handyvertrag" in another concept of the domain: no finding.
  - `test_same_term_is_reported_once`: forbidden "Datei" with both switches on; "Die Konfigurationsdateien" gives one finding.
  - `test_missing_dictionary_skips_the_pass` (Review Focus 2): `dictionaries_dir` pointing at an empty directory: no finding, no exception.
  - `test_symbol_terms_do_not_break_the_pass` (Review Focus 3): forbidden "C++", "a.b", "(x)" with `match_compounds=True`: no exception, findings as with the switch off.
  - `test_compound_pass_requests_no_analysis`: registry stub; a German domain with only compound terms: zero `analyze` calls.
  - In `test_vetting.py`: the existing Hunspell tests still pass through the moved function.
- [ ] **Step 3: Run them.** Expected: fail on the missing modules.
- [ ] **Step 4: Implement.** Candidates come from one scan of the text with `[^\W\d_]+`. Which terms can occur in a candidate is decided by one compiled alternation of all stems (escaped, longest first) searched in the lower-cased candidate, not by a loop over the terms. The dictionary is `hunspell("de", self.dictionaries_dir)`; without it the pass returns nothing.
- [ ] **Step 5: Run the backend gate** on both backends.
- [ ] **Step 6:** Mutation-verify: the "at least one side is a word" condition (watch Bau/Bauer fail); the shortened stem's condition; the three-letter minimum; the same-term rank rule.
- [ ] **Step 7: Commit** `feat(terminology): match switched-on German terms inside compounds`.

---

### Task 6: Term check endpoint

**Files:**
- Create: `backend/app/checkers/term_check.py`, `backend/tests/data/lone_reading_de.json`, `backend/tests/data/lone_reading_it.json`
- Modify: `backend/app/api/terminology.py`, `backend/app/checkers/terminology.py`
- Test: `backend/tests/test_term_check.py`

**Interfaces:**
- Consumes: `analyse_lone`, `part_of_speech_of`, `TERM_FORMS` from Task 3; `hunspell` from Task 5.
- Produces, in the checker module:

```python
@dataclass(frozen=True)
class TermHit:
    text: str
    start: int
    end: int
    part_of_speech: PartOfSpeech
    base_form: str
def find_term(text: str, language: Language, term: ConceptTerm, *, nlp, dictionaries_dir) -> list[TermHit]   # Reading 15, sorted by start
```

- Produces, in `app/checkers/term_check.py`:

```python
LONE_READING_LANGUAGES: frozenset[Language]      # set by Step 1's measurement; German and Italian are the only candidates

class TermCheckRequest(BaseModel):
    language: Language
    text: str = Field(min_length=1, max_length=200)
    part_of_speech: PartOfSpeech | None = None
    context: str = Field(default="", max_length=1000)
    usage_status: UsageStatus
    match_inflections: bool = False
    match_compounds: bool = False

class Recognised(BaseModel):
    part_of_speech: PartOfSpeech
    source: Literal["dictionary", "example", "phrase"]

class ExampleResult(BaseModel):
    found: bool
    matched: str = ""
    part_of_speech: PartOfSpeech | None = None
    base_form: str = ""

class TermCheckResult(BaseModel):
    recognised: list[Recognised]
    known: bool | None
    base_form: str | None
    example: ExampleResult | None           # None when context is empty
    needs_example: bool
    inflections: Literal["supported", "no_model", "unsupported"]
    compounds: Literal["supported", "no_dictionary", "unsupported"]

def check_term(request: TermCheckRequest, *, nlp: "NlpRegistry", dictionaries_dir: Path | None) -> TermCheckResult
```

- Produces: `POST /api/terminology/term-check`, body `TermCheckRequest`, answer `TermCheckResult`, `Depends(get_current_user)`, declared `async def` so that it runs on the event loop like `create_check` and never calls a pipeline from two threads.

- [ ] **Step 1: Measure the lone reading for German and Italian** (spec 8.3). Write the two data files: 200 common terms each as `{"text", "part_of_speech"}`, about 120 nouns, 50 verbs and 30 adjectives, in their base form. Write `test_lone_reading_accuracy`, parametrised over both languages: the share of terms whose `part_of_speech_of(analyse_lone(...).head_tag)` fits the expected value by Reading 5 is at least 0.95 exactly when the language is in `LONE_READING_LANGUAGES`. Run it once with an empty set to read the two shares, set the constant accordingly, and state both shares in the task report.
- [ ] **Step 2: Write the failing tests** for `check_term`, with the `nlp_registry` fixture.

  | Case | Request | Expected |
  |---|---|---|
  | English, two readings | en "file" | `recognised` noun and verb from `dictionary`; `known True`; `needs_example False` |
  | English, unknown | en "dockerize" | `recognised []`; `known False`; `needs_example True` |
  | English, inflected | en "files" | `base_form "file"` |
  | English, example | en "file", context "We filed the report." | `example` found, `matched "filed"`, verb, `base_form "file"`; first `recognised` entry has source `example` |
  | English, example without the term | en "file", context "Nothing here." | `example.found False`; `needs_example False` (dictionary entry exists) |
  | English, phrase | en "part of speech" | `recognised` noun from `phrase`; `known None`; `base_form None`; `needs_example True` |
  | French | fr "fichier" | noun from `dictionary`; `known True` |
  | Spanish, listed | es "archivo" | noun from `dictionary`; `known None` |
  | Spanish, not listed | es "dockerizar" | `recognised []`; `known None`; `needs_example True` |
  | Japanese verb | ja "読み込む" | verb from `dictionary`; `known True` |
  | Japanese unknown | ja "クバネティス" | `known False` |
  | Japanese inflected | ja "美しく" | `base_form "美しい"` |
  | German | de "Datei" | `known None`; `needs_example True`; `recognised` per `LONE_READING_LANGUAGES` |
  | German, example | de "Datei", context "Wir prüfen die Dateien." | `example` found, `matched "Dateien"`, noun, `base_form "Datei"`; `needs_example False` |
  | German compound example | de "Handy", context "Der Handyvertrag läuft aus." | `example` found, `matched "Handyvertrag"`, noun |
  | Chinese | zh "文件" | `inflections "unsupported"`, `compounds "unsupported"` |
  | Missing model | de "Datei" with `NlpRegistry({"de": "xx_bogus_model"})` | `inflections "no_model"`; nothing raised |
  | Missing dictionary | de "Handy", empty `dictionaries_dir` | `compounds "no_dictionary"` |
  | Not German | en "file" | `compounds "unsupported"` |

  Endpoint tests (Review Focus 4): without a session 401; `text` of 10,000 characters 422; `context` of 10,000 characters 422; language "xx" 422; a valid request 200 with the fields above; the store is not touched (the change log is empty afterwards and no domain exists).
- [ ] **Step 3: Run** `rtk proxy uv run pytest -q tests/test_term_check.py`. Expected: fail on the missing module.
- [ ] **Step 4: Implement.** Dictionary sources (spec 8.2): for `en`, `fr`, `es` the table `nlp.get(lang).get_pipe("lemmatizer").lookups.get_table("lemma_index")`, whose keys are the hashes of `"noun"`, `"verb"`, `"adj"`, `"adv"` (`spacy.strings.hash_string`); for `ja` the dictionary tokenizer `nlp.get("ja").tokenizer.tokenizer`, where a term is known when `tokenize(text)` gives one morpheme with `is_oov()` false, and its part of speech is the tag of the spaCy token. `find_term` builds one `_Entry` from the draft and runs the three passes without the hit filters of Task 4.
- [ ] **Step 5: Run the backend gate** on both backends.
- [ ] **Step 6:** Mutation-verify: `needs_example`; the precedence of `example` in `recognised`; the two length limits.
- [ ] **Step 7: Commit** `feat(terminology): term check for the editor`.

---

### Task 7: Switches and term check in the editor

**Files:**
- Create: `frontend/src/terminology/termCheck.ts`, `termCheck.test.ts`, `useTermCheck.ts`, `useTermCheck.test.tsx`, `TermCheckNotes.tsx`
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`, `frontend/src/terminology/conceptDraft.ts`, `conceptDraft.test.ts`, `LanguageSectionEditor.tsx`, `ConceptEntry.test.tsx`, `frontend/src/i18n/messages.ts` and the seven catalogs, the stylesheet that holds `.term-details`

**Interfaces:**
- Consumes: the endpoint and field names of Tasks 1 and 6.
- Produces, in `types.ts`: `match_inflections: boolean` and `match_compounds: boolean` on `ConceptTerm`, optional on `TermInput`; `TermCheckRequest` and `TermCheckResult` mirroring Task 6.
- Produces, in `client.ts`: `postTermCheck(body: TermCheckRequest, signal?: AbortSignal): Promise<TermCheckResult>`.
- Produces, in `termCheck.ts`:

```ts
export type TermCheckNote =
  | { kind: 'recognised'; parts: PartOfSpeech[] }
  | { kind: 'notKnownAs'; part: PartOfSpeech }
  | { kind: 'unknown' } | { kind: 'baseForm'; baseForm: string } | { kind: 'needsExample' }
  | { kind: 'exampleFound'; part: PartOfSpeech; baseForm: string } | { kind: 'exampleMissing' }
  | { kind: 'noModel' } | { kind: 'noDictionary' } | { kind: 'noEffect' }
export function termCheckNotes(term: TermDraft, language: Language, result: TermCheckResult | null): TermCheckNote[]
export function showsInflections(language: Language): boolean   // every language except 'zh'
export function showsCompounds(language: Language): boolean     // 'de' only
```

- Produces, in `useTermCheck.ts`: `useTermCheck(language: Language, term: TermDraft, enabled: boolean): TermCheckResult | null`.

**Texts** (English, verbatim; `X`, `B` and the part of speech are parameters, the part-of-speech name comes from `partOfSpeechName`):

| Key | Text |
|---|---|
| `contextLabel` (changed) | Example sentence |
| `matchInflectionsLabel` | Also match inflected forms |
| `matchCompoundsLabel` | Also match inside compounds |
| `termCheckRecognised` | Recognised as noun or verb. (the names joined by " or ") |
| `termCheckSetPartOfSpeech` | Set part of speech to noun (accessible name of each button) |
| `termCheckNotKnownAs` | “X” is not known as a verb. Inflected forms of that kind may be missed. Add an example sentence to test it. |
| `termCheckUnknown` | “X” is not in the dictionary. Inflected forms are recognised by rule and may be missed. |
| `termCheckBaseForm` | “X” looks like an inflected form of “B”. |
| `termCheckNeedsExample` | Add an example sentence so that the part of speech can be determined. |
| `termCheckExampleFound` | Found in your example as a verb (base form “B”). |
| `termCheckExampleMissing` | Not found in your example sentence. |
| `termCheckNoModel` | Inflected forms cannot be matched: the language model is not installed. |
| `termCheckNoDictionary` | Compounds cannot be matched: the German dictionary is not installed. |
| `termCheckNoEffect` | This only has an effect on forbidden and deprecated terms. |

**Which note appears when** (`termCheckNotes`), in this order; `result === null` gives only `noEffect` where it applies:

1. `noEffect`: a switch is on and the usage status is preferred or admitted.
2. `noModel`: `match_inflections` is on and `inflections === 'no_model'`.
3. `noDictionary`: `match_compounds` is on and `compounds === 'no_dictionary'`.
4. `baseForm`: `base_form` is set.
5. `exampleFound` or `exampleMissing`: `example` is not null.
6. `recognised`: `recognised` is not empty and the term has no part of speech; the parts without duplicates, in the order given.
7. `notKnownAs`: the term has a part of speech other than `other`, `recognised` is not empty and does not contain it.
8. `unknown`: `known === false`.
9. `needsExample`: `needs_example` is true.

- [ ] **Step 1: Write the failing tests.**
  - `conceptDraft.test.ts`: toggling `match_inflections` on a saved term counts as one change and is sent in the section input; a new term has both false.
  - `termCheck.test.ts`: one test per numbered rule above, each with a result that triggers only that rule; one test that a result triggering rules 4, 6 and 9 gives the three notes in that order; `showsInflections('zh') === false`, `showsCompounds('en') === false`, `showsCompounds('de') === true`.
  - `useTermCheck.test.tsx`: no call while `enabled` is false; one call 400 ms after the last change of text, part of speech, example, usage status or a switch (fake timers); a failed call gives `null` and no error on screen; **stale answer** (Review Focus 5): the call for "fil" resolves after the call for "file" was started: the hook returns the answer for "file" only.
  - `ConceptEntry.test.tsx`: in a German section the details show both switches, in an English section only the first, in a Chinese section neither; with a mocked answer `recognised: [noun, verb]` two buttons appear and a click on "verb" sets the select to verb; the example field is labelled "Example sentence"; saving sends the switches.
- [ ] **Step 2: Run** `rtk proxy npm test -- conceptDraft termCheck useTermCheck ConceptEntry`. Expected: fail on the missing modules and fields.
- [ ] **Step 3: Implement.** `useTermCheck` is enabled while the term's details are open and its text is not blank. It aborts the previous request and ignores an answer whose request is not the latest. `TermCheckNotes` renders the notes as a list with `role="status"` below the part-of-speech row; the part-of-speech buttons use `.link-button`. New style rules use theme tokens only.
- [ ] **Step 4: Run the frontend gate.**
- [ ] **Step 5:** Mutation-verify the latest-request rule, the visibility of the two switches, and rules 1 and 7.
- [ ] **Step 6: Commit** `feat(terminology): switches and term check in the term details`.

---

### Task 8: Base-form suggestions in the sidebar

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/findings/suggestions.ts`, `suggestions.test.ts`, `frontend/src/sidebar/Sidebar.tsx`, `frontend/src/i18n/messages.ts` and the seven catalogs
- Create: `frontend/src/sidebar/Sidebar.baseForm.test.tsx`
- Possibly modify (Step 1): `backend/app/checkers/terminology.py`, `backend/tests/test_terminology_inflections.py`

**Interfaces:**
- Consumes: `Finding.suggestions_base_form` from Task 3.
- Produces: `suggestions_base_form?: boolean` on the frontend `Finding`; `effectiveSuggestions(finding, extras)` returns the finding's own suggestions followed by the fetched ones, without duplicates, when `suggestions_base_form` is true, and behaves as today otherwise.

**Text:** `baseFormSuggestionNote`: "Base form. Adjust the ending to fit the sentence."

- [ ] **Step 1: Live test of the existing prompt (spec 7.5), on the owner's cue.** For German, French, Spanish and Italian, five sentences each with an inflected forbidden term and a preferred term (plural, case or tense differing from the base form). Call `build_suggestion_prompt` with the finding's message and span and send it through the configured cheap tier; the key is read from `~/.fw-anthropic-key` inline, never exported. A language passes when at least four of five answers contain the preferred term in the form that fits. Record sentences, answers and verdicts in the task report. If a language fails: `_base_form_finding` appends the sentence `Use the form that fits the sentence.` to the message when `suggestions_base_form` is true, in all languages, with its test in `test_terminology_inflections.py`; repeat the live test once.
- [ ] **Step 2: Write the failing tests.**
  - `suggestions.test.ts`: with the flag, own suggestions come first and fetched ones follow; a fetched text equal to an own one appears once; without the flag the existing three tests pass unchanged.
  - `Sidebar.baseForm.test.tsx`: a terminology finding with `suggestions: ['Dokument']` and the flag shows the button "Dokument", the note, and "Suggest fix"; without the flag neither note nor "Suggest fix" is shown; after a mocked fetch that returns "Dokumente" both buttons are shown and "Suggest fix" is gone; a click on "Dokumente" applies it; a finding without suggestions shows "Suggest fix" as today.
- [ ] **Step 3: Run** `rtk proxy npm test -- suggestions Sidebar`. Expected: the new tests fail.
- [ ] **Step 4: Implement.** In the suggestion area of `Sidebar.tsx`, a finding with the flag renders its buttons, the note, and, while nothing has been fetched for it, the same "Suggest fix" button and pending and error states the branch without suggestions uses. No change to `fetchSuggestions` or the request it sends.
- [ ] **Step 5: Run the frontend gate** (and the backend gate if Step 1 changed the message).
- [ ] **Step 6:** Mutation-verify the flag condition in `effectiveSuggestions` and in the sidebar.
- [ ] **Step 7: Commit** `feat(sidebar): base-form suggestions carry a note and offer Suggest fix`.

---

### Task 9: Measurements and documentation

**Files:**
- Create: `backend/scripts/measure_terminology_check.py`
- Modify: `docs/backend-architecture.md` (section "Terminology"), `docs/frontend-architecture.md` (section "Terminology screen")

- [ ] **Step 1: Write the script.** It builds an in-memory store, and for German and English measures the median of 20 runs of the rules and terminology steps of `create_check` on a 5,000-character text with 0, 10 and 1,000 terms that have `match_inflections` on, each with and without the rules checker, once with a cold and once with a warm term cache. It prints one table. It is run by hand and is not part of the test suite.
- [ ] **Step 2: Run it** on `main` (the rows with 0 terms only) and on the branch. Expected on the branch: the rows with 0 terms within measurement noise of `main`; with the rules checker and a warm cache, 1,000 terms add less than 5 ms. A larger value is reported, not tuned away silently.
- [ ] **Step 3: Record** the table, the backend suite time before and after, and the `npm test` time before and after in the task report, for the pull request description and the logbook.
- [ ] **Step 4: Update the two architecture documents:** the passes and their order, when an analysis is requested, the term cache, the compound rule and its accepted errors, the term check and its sources per language, the known limits of spec section 10, the sidebar handling of `suggestions_base_form`.
- [ ] **Step 5: Commit** `docs: terminology matching of inflected forms and compounds`.

The logbook entry is written as the last commit of the branch, on the owner's cue, under the pull request's number.

## Self-review

- **Spec coverage.** Section 5: Task 1. 6.1 to 6.4: Tasks 2 to 4. 6.5: Task 5. 6.6: Task 3. 7.4: Task 3 (the flag). 7.5: Task 8. 8: Tasks 6 and 7. 9: Tasks 2, 3 and 9. 10: Task 9. 13: each bullet has its tests in the task that owns the code; the generators' tests belong to the second plan.
- **Deviations from the spec, none.** Two places where the plan is narrower than the spec's wording, both recorded as Readings: the compound pass ignores terms that contain a hyphen (Reading 1), and it uses a word's base form only when an analysed document already exists (Reading 9).
- **Open measurement results** that decide code: `LONE_READING_LANGUAGES` (Task 6, Step 1) and the optional message sentence (Task 8, Step 1). Both have a defined rule and a defined outcome for either result.
