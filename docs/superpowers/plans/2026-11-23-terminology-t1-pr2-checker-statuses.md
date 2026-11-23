# Terminology T1, Pull Request 2: Checker Statuses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The terminology checker honours usage status and process status: forbidden terms are errors, deprecated terms are warnings, candidates are ignored, and replacements fall back from the preferred term to the admitted terms.

**Architecture:** Only `app/checkers/terminology.py` changes its behaviour. Each language section becomes one internal entry with three lists: the terms that are reported, the terms whose casing is checked, and the replacement texts. The four matching paths (regular expression, tokens, and the two substring fallbacks) stay as they are and iterate over these lists. The store read the checker uses filters by language in the database.

**Tech Stack:** Python 3, Pydantic v2, SQLite and Postgres through the shared database seam, spaCy tokenisers for Japanese and Chinese, pytest.

**Spec:** `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-design.md`, section 8, with 5.3 and 5.5 for the terms it uses. Executors read both documents.

## Global Constraints

- **Branch:** all work on `terminology-t1-pr2-checker-statuses`, created from `main`. Never commit to `main`.
- **Backend only.** No file under `frontend/` or `clients/` changes.
- **No schema change, no migration, no API change.** If a task seems to need one, stop: the plan is wrong.
- **`backend/tests/data/terminology_baseline.json` is not edited** and `tests/test_terminology_baseline.py` stays green in every commit. Data in which every section has an active preferred term, every term is active and either preferred or forbidden, and no status reason is set must give exactly today's findings, messages and order. The baseline comparison sorts findings before comparing, so it does not guard the order; Task 2 has its own test for that.
- **Commit trailer on every commit:** `Co-Authored-By: <model> <noreply@anthropic.com>`, naming the model that makes the commit.
- **Commands** run from `backend/` with `rtk proxy uv run …`. The shell's working directory is reset between calls: use `cd /Users/markus/IdeaProjects/fabulous-writing/backend && …` in the same command.
- **Gate for every task:** `rtk proxy uv run pytest -q` green with zero warnings, once without and once with the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (local `supabase start` stack; the controller confirms it is up before Task 1).
- **Mutation-verify every new behaviour test:** change the rule it pins, watch the test fail, restore by re-editing the file (never `git checkout <file>`). State in the task report which mutation was run and how the test failed.
- **Severity values, verbatim** (`app/core/models.py`): `Severity.ERROR`, `Severity.WARNING`.
- **Message texts, verbatim.** They are fixed in "Readings" below; tests compare whole messages.
- **IDE tools.** The project is open in IntelliJ IDEA and its MCP tools work on this checkout (load them with ToolSearch, pass `projectPath=/Users/markus/IdeaProjects/fabulous-writing`). Prefer `search_symbol`, `search_text` and `get_file_problems` where they fit. Do not use the IDE's terminal, run-configuration, debugger or database tools.
- **No comments that retell the code.**
- **Suite runtime:** the local baseline is about 23 s on SQLite. Report a task that adds more than 2 s.
- **Ports 5173 and 8000** belong to the owner's dev servers. Never start, stop or bind anything there.

## Readings of the spec that this plan fixes

A reviewer checks the code against these, not against a different reading.

1. **Which terms take part.** Only terms whose process status is enforced (`is_enforced`). A candidate is not matched, not checked for casing and never offered as a replacement.
2. **Replacements of a section:** the texts of its enforced preferred terms sorted by `(text.casefold(), text)` (one at most today; the code works on a list, as spec 5.3 asks); if there is none, the texts of its enforced admitted terms sorted the same way; otherwise none. A deprecated or forbidden term is never a replacement.
3. **Status finding:** a match of an enforced forbidden term is `Severity.ERROR`, of an enforced deprecated term `Severity.WARNING`. `suggestions` is the section's replacement list.
4. **Message of a status finding,** in this order, parts joined by one space:
   - with replacements: `Use 'A' instead of 'M'.`, with several `Use 'A' or 'B' instead of 'M'.` (every replacement quoted, joined by ` or `);
   - without: `'M' is forbidden.` or `'M' is deprecated.`;
   - the matched term's `status_reason`, if not empty, unchanged;
   - the section's definition, if not empty, unchanged.
   `M` is the text as it stands in the document.
5. **Casing finding:** for every enforced preferred or admitted term with `case_sensitive`, a match in another casing is `Severity.ERROR`, with the existing sentence-start exception. The replacement is the term's own text, also for an admitted term: `Use 'T' instead of 'M'.`, then the definition. No status reason: it explains a status, not a spelling. Three limits, added after review R1: a match whose text equals an enforced preferred or admitted term of the same section is not a finding (the store allows two terms that differ only in case); a span that any matching cased term of the section accepts, sentence-start exception included, is not a finding; otherwise there is one finding per section and span, for the first cased term in the order preferred terms, then admitted terms, each sorted by `(text.casefold(), text)`.
6. **Overlaps within one domain.** A warning that overlaps an error is dropped. Two overlapping status findings of the same severity are both kept, as today. A casing finding that overlaps any kept status finding is dropped, also when the status finding is a warning.
7. **A section without any reported or cased term** produces nothing. A section with forbidden terms and no preferred term is reported now; this includes the rows that the migration carried over from old data with an empty preferred wording (first plan, reading 8).
8. **Order.** Sections with an enforced preferred term come first, sorted by the first of their replacement texts, which is today's key; the others follow in store order. Findings are sorted by span with a stable sort, as today.
9. **Rule id** stays `terminology.<uid of the matched term>`.
10. **Several domains:** nothing changes in `app/api/checks.py`. The test that a shared concept is reported once is added there because spec section 14 asks for it. One effect is reachable for the first time: `drop_duplicates` drops a later domain's finding that overlaps an earlier domain's finding whatever their severities, so an error can be hidden by a warning from an earlier domain. It is left as it is and belongs to #211; Task 4 documents it.
11. **The store read filters by language in SQL.** `list_sections` keeps its signature and its result; only the queries change. No test can show the difference, so the reviewer reads the SQL.

## What the third pull request needs from this one

Nothing new. The checker keeps reading `TerminologyStore.list_sections(domain_id, *, owner_id, language)`.

## File Structure

| File | Change |
|---|---|
| `backend/app/services/terminology/rows.py` | New `load_domain_sections`; row-to-model helpers shared with `_load`. |
| `backend/app/services/terminology/store.py` | `list_sections` calls it. |
| `backend/app/checkers/terminology.py` | Entry model, severity, replacements, messages, casing for admitted terms, overlap rule. |
| `backend/tests/terminology_helpers.py` | `add_concept` helper for terms with any status. |
| `backend/tests/test_terminology_checker_statuses.py` | New. All tests of this pull request for the checker. |
| `backend/tests/test_terminology.py` | One existing test replaced (Task 2). |
| `backend/tests/test_terminology_store.py` | Tests for `list_sections` (Task 1). |
| `backend/tests/test_terminology_migration.py` | One test for old rows with an empty preferred wording (Task 2). |
| `backend/tests/test_check_api.py` | Shared concept in two domains (Task 3). |
| `docs/backend-architecture.md` | Checker section (Task 4). |
| `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-design.md` | Section 8, the sentences Task 4 names. |
| `docs/LOGBOOK.md` | Entry for this pull request, last commit, on the owner's cue. |

---

### Task 1: The store reads one language

**Files:**
- Modify: `backend/app/services/terminology/rows.py`, `backend/app/services/terminology/store.py`
- Test: `backend/tests/test_terminology_store.py`, `backend/tests/terminology_helpers.py`

**Interfaces:**
- Produces: `rows.load_domain_sections(conn, domain_id: int, *, user_id: int | None, language: Language) -> list[LanguageSection]`; unchanged `TerminologyStore.list_sections(domain_id: int, *, owner_id: int, language: Language) -> list[LanguageSection] | None`.
- Produces for tests: in `tests/terminology_helpers.py`

```python
def add_concept(
    store: TerminologyStore,
    domain_id: int,
    *,
    language: Language,
    terms: Sequence[tuple[str, UsageStatus, ProcessStatus] | TermInput],
    definition: str = "",
    actor: Actor = _ADMIN,
) -> Concept
```

  A tuple becomes a `TermInput` with defaults for the other fields; a `TermInput` is passed through. It calls `store.create_concept` with one `SectionInput` and asserts the result is not `None`.

- [ ] **Step 1: Extend the two existing tests** in `test_terminology_store.py`; do not add near-copies. Both use the `db` fixture and run on both backends.
  - `test_list_sections_returns_one_language`: add a concept that has an EN and a DE section (the second added with `save_section`) and a concept with a DE section only. EN returns exactly the EN sections in concept order; DE returns the two DE sections in concept order; every returned section carries all of its terms with `usage_status`, `process_status`, `status_reason`, `case_sensitive` and `uid`.
  - `test_get_and_list_respect_visibility`: add that `list_sections` returns `None` for an unknown domain id and returns the sections of a global domain to user 2.

- [ ] **Step 2: Run them.** Expected: PASS already (the current code filters in Python). They pin the result before the queries change.

- [ ] **Step 3: Implement `load_domain_sections`.** Two queries: the sections of the language whose concept is linked to the domain and visible to the user (`visible_clause()` on the concept, as in `load_domain_concepts`), ordered by `concept_id, id`; then the terms of those sections ordered by `id`. Build `LanguageSection` and `ConceptTerm` with the same helpers `_load` uses; extract a `_section_from_row(row, terms)` helper from `_load` so there is one place that maps a section row. `list_sections` keeps its domain visibility check and returns the new function's result.

- [ ] **Step 4: Run the gate** on both backends. Expected: green, baseline test included.

- [ ] **Step 5: Commit** `refactor(terminology): list_sections filters by language in the database`.

---

### Task 2: Status findings, replacements and messages

**Files:**
- Modify: `backend/app/checkers/terminology.py`
- Create: `backend/tests/test_terminology_checker_statuses.py`
- Modify: `backend/tests/test_terminology.py` (remove `test_section_without_preferred_term_yields_nothing`; its replacement is in the new file), `backend/tests/test_terminology_migration.py`

**Interfaces:**
- Consumes: `add_concept` from Task 1; `is_enforced`, `UsageStatus`, `ProcessStatus`, `ConceptTerm`, `LanguageSection` from `app.services.terminology`.
- Produces, internal to the checker module and used by Task 3:

```python
@dataclass(frozen=True)
class _Entry:
    reported: list[ConceptTerm]      # enforced forbidden and deprecated terms
    cased: list[ConceptTerm]         # filled in Task 3; in this task: the enforced preferred term if case_sensitive
    replacements: list[str]
    definition: str
    order: tuple[bool, str]          # (no enforced preferred term, first preferred text or ""), see Reading 8

def _entry(section: LanguageSection) -> _Entry | None   # None when reported and cased are both empty
def _status_finding(entry: _Entry, term: ConceptTerm, matched: str, start: int, end: int) -> Finding
def _casing_finding(entry: _Entry, term: ConceptTerm, matched: str, start: int, end: int) -> Finding
```

  The four matching methods iterate `entry.reported` where they iterate `entry.forbidden` today, and `entry.cased` where they use `entry.preferred` today. `_casing_ok` receives the cased term's text.

- [ ] **Step 1: Write the failing tests** in the new file. Fixtures: a `store(db)` fixture as in `test_terminology.py` (both backends); a helper `check(store, domain, text, language=Language.EN, nlp=None)` that returns the findings. Every test creates its own domain. `P, A, D, F` are the usage statuses; `ACTIVE, CANDIDATE` the process statuses.

```python
def test_severity_follows_the_usage_status(store):
    # section: sign in (P), log on (A), login (F), log-in (D), all ACTIVE
    # text "Please login, log-in or log on, then sign in."
    # -> exactly two findings: "login" ERROR, "log-in" WARNING

def test_candidates_are_ignored_completely(store):
    # section: sign in (P, ACTIVE), login (F, CANDIDATE)  -> "Please login." gives []
    # section: enter (P, CANDIDATE), logon (F, ACTIVE)    -> "Please logon." gives one finding
    #   with suggestions == [] and message == "'logon' is forbidden."

def test_replacement_falls_back_to_the_admitted_terms(store):
    # section: log on (A), Access (A), login (F), no preferred
    # -> suggestions == ["Access", "log on"], message == "Use 'Access' or 'log on' instead of 'login'."

def test_preferred_term_wins_over_admitted_terms_as_replacement(store):
    # section: sign in (P), log on (A), login (F) -> suggestions == ["sign in"]

def test_deprecated_and_forbidden_terms_are_never_replacements(store):
    # section: login (F), log-in (D) -> both reported, both with suggestions == []
    # messages "'login' is forbidden." and "'log-in' is deprecated."

@pytest.mark.parametrize("preferred, reason, definition, expected", [
    ("sign in", "Legal asked for it.", "Enter the product.",
     "Use 'sign in' instead of 'login'. Legal asked for it. Enter the product."),
    (None, "Legal asked for it.", "Enter the product.",
     "'login' is forbidden. Legal asked for it. Enter the product."),
    ("sign in", "Legal asked for it.", "", "Use 'sign in' instead of 'login'. Legal asked for it."),
    ("sign in", "", "Enter the product.", "Use 'sign in' instead of 'login'. Enter the product."),
])
def test_message_carries_status_reason_then_definition(store, preferred, reason, definition, expected):
    # one section per case: login (F) with status_reason, the preferred term if given

def test_message_quotes_the_text_as_written(store):
    # sign in (P), login (F, case-insensitive), text "Please LOGIN."
    # -> message == "Use 'sign in' instead of 'LOGIN'." and span.text == "LOGIN"

def test_section_with_only_admitted_and_preferred_terms_reports_nothing(store):
    # sign in (P), log on (A), neither case-sensitive -> [] for a text that contains both

def test_rule_id_is_the_uid_of_the_deprecated_term(store):

def test_findings_on_the_same_span_follow_the_preferred_text(store):
    # created in this order: section 1 preferred "b", section 2 preferred "a"; both forbid "login"
    # "Please login." -> suggestions in the order ["a"], then ["b"]

def test_sections_with_a_preferred_term_come_first(store):
    # created in this order: section 1 without preferred, forbids "login";
    # section 2 with preferred "zeta", forbids "login"
    # -> both findings kept, the one suggesting "zeta" first

@pytest.mark.parametrize("language, preferred, deprecated, text", [
    (Language.JA, "利用者", "ユーザー", "ユーザーはこの機能を使います。"),
    (Language.ZH, "用户", "使用者", "使用者可以使用这个功能。"),
])
def test_cjk_token_path_reports_deprecated_terms_as_warnings(store, language, preferred, deprecated, text):
    # nlp=NlpRegistry(NlpSettings().models), built inline as in TestCjkChecker
    # -> one WARNING on the deprecated term, suggestions == [preferred]

def test_cjk_substring_fallback_reports_deprecated_terms_as_warnings(store):
    # nlp=None
```

  In `test_terminology_migration.py`:

```python
def test_old_row_with_an_empty_preferred_wording_is_checked_again(sqlite_db):
    # legacy row: preferred "", variants ["login"], definition "Enter."
    # after the migration a check of "Please login." gives one ERROR,
    # suggestions == [], message == "'login' is forbidden. Enter."
```

- [ ] **Step 2: Run them.** Expected: most FAIL (deprecated terms not reported, sections without preferred skipped). Four pass on today's code and are pinned by a mutation after Step 3 instead:
  - `test_preferred_term_wins_over_admitted_terms_as_replacement` (mutation: put admitted terms into the replacements even when a preferred term exists);
  - `test_section_with_only_admitted_and_preferred_terms_reports_nothing` (mutation: report admitted terms);
  - `test_message_quotes_the_text_as_written` (mutation: use the term's text in the message);
  - `test_findings_on_the_same_span_follow_the_preferred_text` (mutation: drop the text from the sort key).
  The first half of `test_candidates_are_ignored_completely` also passes today (mutation: remove the `is_enforced` filter).

- [ ] **Step 3: Implement** `_Entry`, `_entry`, `_status_finding`, `_casing_finding` as given under Interfaces and Readings 1 to 5 and 7 to 9, and switch the four matching methods to the two lists. `check` sorts entries by `order` (stable). Severity comes from a module-level mapping `{UsageStatus.FORBIDDEN: Severity.ERROR, UsageStatus.DEPRECATED: Severity.WARNING}`.

- [ ] **Step 4: Run the gate** on both backends. The baseline test and every other test of `tests/test_terminology.py` must pass without an edit, apart from the one removed test.

- [ ] **Step 5: Commit** `feat(terminology): the checker honours usage and process status`.

---

### Task 3: Casing of admitted terms, overlaps, several domains

**Files:**
- Modify: `backend/app/checkers/terminology.py`
- Test: `backend/tests/test_terminology_checker_statuses.py`, `backend/tests/test_check_api.py`

**Interfaces:**
- Consumes: `_Entry`, `_casing_finding` from Task 2.
- Produces: `_Entry.cased` holds every enforced preferred or admitted term with `case_sensitive`; `_resolve_overlaps(status: list[Finding], casing: list[Finding]) -> list[Finding]` replaces `_without_overlaps` and returns the kept status findings followed by the kept casing findings.

- [ ] **Step 1: Write the failing tests.**

```python
def test_wrong_casing_of_an_admitted_term_is_an_error(store):
    # section: sign in (P), GitHub (A, case_sensitive)
    # "Open github now." -> one ERROR, suggestions == ["GitHub"],
    # message == "Use 'GitHub' instead of 'github'."  (not "sign in")

def test_sentence_start_exception_holds_for_admitted_terms(store):
    # admitted "sign in" case_sensitive: "Sign in now." -> []
    # "Please Sign in now." -> one ERROR, suggestions == ["sign in"]

def test_casing_of_a_candidate_is_not_checked(store):

def test_casing_finding_has_no_status_reason(store):
    # preferred GitHub (case_sensitive, status_reason "Brand."), definition "Code hosting."
    # -> "Use 'GitHub' instead of 'github'. Code hosting."

def test_warning_overlapping_an_error_is_dropped(store):
    # concept 1: e-mail (F); concept 2: mail (D), same domain
    # "Send an e-mail." -> only the ERROR on "e-mail"

def test_overlapping_findings_of_the_same_severity_are_both_kept(store):
    # concept 1: e-mail (F); concept 2: mail (F) -> two findings

def test_status_warning_wins_over_a_casing_error(store):
    # concept 1: GitHub (P, case_sensitive); concept 2: github (D, case-insensitive), email (P)
    # "Open github." -> exactly one finding, the WARNING

def test_non_overlapping_warning_next_to_an_error_is_kept(store):

def test_cjk_casing_covers_admitted_terms(store):
    # Japanese text with an embedded Latin admitted term, case_sensitive, token path and nlp=None
```

  In `test_check_api.py`, with the store taken from `client.app.state.terminology_store`:

```python
def test_concept_shared_by_two_domains_is_reported_once(client):
    # create a concept with a forbidden term in domain 1, then link it to domain 2
    # with save_concept(concept.id, domain_ids=[d1, d2], revision=concept.revision, ...)
    # POST /api/checks with domain_ids [d1, d2] -> one terminology finding
    # with domain_ids [d2] alone -> the same finding (the link is real)
```

- [ ] **Step 2: Run them.** Expected to FAIL: `test_wrong_casing_of_an_admitted_term_is_an_error`, `test_sentence_start_exception_holds_for_admitted_terms`, `test_warning_overlapping_an_error_is_dropped`, `test_cjk_casing_covers_admitted_terms`. The others pass already, because Task 2 kept the rule that a casing finding yields to any status finding; each is pinned by a mutation after Step 3:
  - `test_casing_of_a_candidate_is_not_checked`: remove the `is_enforced` filter from `cased`;
  - `test_casing_finding_has_no_status_reason`: append the reason in `_casing_finding`;
  - `test_overlapping_findings_of_the_same_severity_are_both_kept`: drop on equal severity too;
  - `test_status_warning_wins_over_a_casing_error`: let casing findings yield to errors only;
  - `test_non_overlapping_warning_next_to_an_error_is_kept`: drop every warning when an error exists;
  - `test_concept_shared_by_two_domains_is_reported_once`: replace `drop_duplicates(more, findings)` with `more` in `app/api/checks.py`, two findings.

- [ ] **Step 3: Implement** `cased` for admitted terms and `_resolve_overlaps` per Reading 6. Two spans overlap when `a.start < b.end and b.start < a.end`, as in the function it replaces.

- [ ] **Step 4: Run the gate** on both backends.

- [ ] **Step 5: Commit** `feat(terminology): casing of admitted terms and the overlap rule`.

---

### Task 4: Documentation

**Files:**
- Modify: `docs/backend-architecture.md` (the terminology checker part: what is loaded, the severity table, replacements, messages, the overlap rule, the order of entries, `list_sections` filtering in SQL).
- Modify: the spec, section 8. Required: a casing finding carries no status reason (Reading 5; the spec's sentence on the message does not limit the reason to status findings). Add where the code as built needs it: the wording of the message with several replacements and without one (Reading 4), and that equal-severity overlaps are both kept (Reading 6).
- The architecture notes also state the cross-domain effect of Reading 10.

- [ ] **Step 1:** Write the changes from the code as built, not from this plan.
- [ ] **Step 2:** Run the gate once more on both backends.
- [ ] **Step 3: Commit** `docs: terminology checker statuses`.

---

## Review Focus

Inputs the spec implies and that its test list does not name. Each has its test in the task that owns the code.

1. **A section whose only preferred term is a candidate** has no replacement, and its forbidden terms are still reported. Task 2, `test_candidates_are_ignored_completely`.
2. **An old row with an empty preferred wording** is checked again after this pull request, without a suggestion. Task 2, `test_old_row_with_an_empty_preferred_wording_is_checked_again`.
3. **A deprecated word that is also the wrong casing of a preferred term** gives one finding, not two. Task 3, `test_status_warning_wins_over_a_casing_error`.
4. **A wrongly cased admitted term** must be corrected to itself, not replaced by the preferred term. Task 3, `test_wrong_casing_of_an_admitted_term_is_an_error`.
5. **Japanese and Chinese** go through other matching code than the Latin scripts, for status and for casing. Tasks 2 and 3, the four CJK tests.

## Execution Plan

Subagent-driven, one implementer at a time. The controller (this session's model) dispatches, reads each report, and runs the gate itself on both backends before accepting a task. Models are the `model` values of the Agent tool.

| Task | Implementer | Why this model |
|---|---|---|
| 1 Store read | sonnet | Two queries and a helper extraction; the result is pinned by tests first. |
| 2 Status findings | opus | Four matching paths change together and today's results must stay identical. |
| 3 Casing and overlaps | sonnet | Builds on Task 2's structure; every rule has its test. |
| 4 Documentation | sonnet | Needs the as-built picture of one module. |

| Review | After tasks | Reviewer | Scope |
|---|---|---|---|
| R1 | 1 to 3 | opus | Spec section 8 line by line against the code and the Readings; the baseline file untouched and green; all four matching paths use both lists; the SQL of `load_domain_sections` (visibility, language, order); evidence that the mutation checks were run. |
| Final | whole branch, after 4 | sonnet | Documentation against the code; nothing outside the files listed under File Structure and this plan changed; no frontend file touched. |

Each review gets the spec, this plan, the task reports and the diff of its range, and returns findings with severity, location and a concrete fix. Findings are fixed by the implementer of the task they belong to; the same reviewer then re-checks only those findings. One review covers Tasks 1 to 3 because they change one module and its read, about 300 lines; a second full review on the strongest model after the documentation task would read the same code again.

## Out of plan

- **Pull request, logbook:** the plan goes up as a pull request on the branch named above, and the implementation follows on the same branch. The logbook entry is the last commit, on the owner's cue.
- **Visible effect:** none through the current screen, which can only create active preferred and forbidden terms. The exception is old data with an empty preferred wording (Reading 7).
- **Clients:** a terminology finding without a suggestion is new. The web editor already handles findings without suggestions (LLM findings have none until requested) and then offers to fetch one. No client change is planned; the owner may want to look at such a finding once the third pull request makes it reachable.

## Plan review

Reviewed on 2026-11-23 by an Opus agent against the spec and the code (spec conformance, coherence with the code, the unchanged-results constraint, executability). No critical finding. Two important ones, both applied: the "expected to fail" statements of Tasks 2 and 3 were wrong for several tests, which are now listed with the mutation that pins each; and nothing guarded the order of findings on the same span, which now has its own test. Nine minor ones, all applied: replacements work on a list of preferred terms; the spec sentence on the casing message is required in Task 4; the cross-domain effect of warnings is stated; the unchanged-results constraint is worded exactly; Task 1 extends two existing tests; and five test set-ups are written out.

## Review R1

Opus review of Tasks 1 to 3 on 2026-11-23. Two important findings: a correctly written admitted case variant was reported as wrong casing of the preferred term, and the overlap check was quadratic in the number of findings. Four minor ones: no test with two case-sensitive terms in one section, the concept order of `load_domain_sections` not pinned, a filter written twice, a parameter name. All fixed in `bb698ec` and `7bf9d72` and confirmed by the same reviewer; Reading 5 carries the three limits that came out of it.
