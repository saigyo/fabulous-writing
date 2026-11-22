# Terminology T1, Pull Request 1: Concept Store, Migration and Change Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `terms` table with concepts, language sections and terms, migrate existing data, record every change in an append-only log, and keep the current screen and check results unchanged.

**Architecture:** `app/services/terminology.py` becomes a package: pick-lists and models, the schema, a change-log module that derives entries by comparing a concept before and after a save, the legacy migration, and the store. The store is the only writer; every write locks its rows first, compares the version numbers the caller read, validates the resulting state, applies it and logs it in one transaction. The eight existing term endpoints stay and translate old-style terms to and from language sections. The checker reads sections and reports as before.

**Tech Stack:** Python 3, FastAPI, Pydantic v2, SQLite and Postgres through the shared database seam (`app/services/db/`), pytest.

**Spec:** `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-design.md` (sections 5 including 5.7, 6, 7 and 9.1; section 8 only as far as "reports exactly as before"). Executors read both documents.

## Global Constraints

- **Branch:** all work on `terminology-t1-pr1-concept-store`, created from `main`. Never commit to `main`.
- **Backend only.** No file under `frontend/` or `clients/` changes. If a task seems to need one, stop: the plan is wrong.
- **Commit trailer on every commit:** `Co-Authored-By: <model> <noreply@anthropic.com>`, naming the model that runs the session at execution time. The controller fixes the exact line before Task 1 and gives it to every implementer.
- **Commands** run from `backend/` with `rtk proxy uv run …` (bare `python` does not exist on this machine). The shell's working directory is reset between calls: use absolute paths or `cd /Users/markus/IdeaProjects/fabulous-writing/backend && …` in the same command.
- **Gate for every task:** `rtk proxy uv run pytest -q` green with zero warnings, once without and once with `PG_ENV`. `PG_ENV` means the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (local `supabase start` stack; the controller confirms it is up before Task 1). A task that touches SQL is not done until the Postgres run is green.
- **One schema text for both backends.** Placeholders are `?`; SQL text contains no literal `?` or `%`; booleans are bound as `int(...)`; an `INSERT … RETURNING id` cursor is fetched before the transaction ends (contract in `app/services/db/__init__.py`).
- **Mutation-verify every guard test:** remove the guard, watch the test fail, restore by re-editing the file (never `git checkout <file>`). State in the task report which mutation was run and how the test failed.
- **Change-log entries are never updated or deleted.** No SQL in the package may contain `UPDATE terminology_changes` or `DELETE FROM terminology_changes`.
- **Pick-list values, verbatim.** Usage status: `preferred`, `admitted`, `deprecated`, `forbidden`. Process status: `candidate`, `active`. Part of speech: `noun`, `verb`, `adjective`, `adverb`, `proper_noun`, `other`, or empty. Origin: `manual`, `extraction`, `import`, `migration`, `seed`. Action: `created`, `edited`, `deleted`, `added_to_domain`, `removed_from_domain`, `carried_over`.
- **IDE tools.** The project is open in IntelliJ IDEA and its MCP tools work on this checkout (load them with ToolSearch, pass `projectPath=/Users/markus/IdeaProjects/fabulous-writing`). Prefer them where they fit: `search_symbol` to find a definition, `search_text` or `search_regex` to find every use of a name, `analyze_calls` for callers, `rename_refactoring` for a rename across files, and `get_file_problems` on every Python file you changed before you run the tests. Their results are positions, not text; read the file for the content. Do not use the IDE's terminal, run-configuration, debugger or database tools; tests run through `rtk proxy uv run pytest` as stated above.
- **No comments that retell the code.** A comment states a constraint the code cannot show.
- **Suite runtime:** the local baseline is about 19 s. Report a task that adds more than 3 s.
- **Ports 5173 and 8000** belong to the owner's dev servers. Never start, stop or bind anything there.

## Readings of the spec that this plan fixes

Each is a decision the spec leaves open or states loosely. A reviewer checks the code against these, not against a different reading.

1. **Version numbers are increased unconditionally** (`SET revision = revision + 1`) and compared in Python against the state loaded after locking. The comparison is the check; the lock makes it sound.
2. **No unique index on a term's text.** The store checks uniqueness on the final state of a save, after locking. An index would reject a save that swaps the wordings of two terms.
3. **Lock order.** Every writing transaction first writes value-preserving updates to the domain rows it names (ascending id), then to the concept rows it changes (ascending id), and reads only afterwards. The domain locks close a gap the spec does not mention: without them, deleting a domain while a concept is being created in it leaves a concept without a domain.
4. **The old endpoints use the same checked path.** They read the concept and save with the numbers they just read (`SectionInput.from_section`). The store has no unchecked way to save. In the short window between that read and the save, another write makes the old endpoint answer 409.
5. **Domain links are logged one entry per link** (`added_to_domain`, `removed_from_domain`), because an entry has one action. Field changes on the concept remain one `edited` entry.
6. **A definition is compared as text, an absent section counting as empty.** Adding a section with an empty definition writes no concept entry, only the term entries.
7. **One batch per migrated concept**, all with the same migration time.
8. **Legacy rows that cannot be carried over one-to-one:**
   - a row whose domain no longer exists is not migrated (it is invisible today) and is counted in a warning;
   - a row with an empty preferred wording (possible in data from before the API validated it) becomes a section with its forbidden terms and no preferred term; with no usable variant either, it is skipped with a warning. The checker of this pull request reports nothing for a section without an active preferred term, and the old endpoints do not list it; the second and third pull requests bring both back. Today such a row reports its variants with an empty suggestion. Spec section 6 lists this as the second exception to "checked exactly as before".
9. **"Check results identical" is tested on clean data.** Duplicate variants produce duplicate findings today and are skipped by the migration, so the equality test uses data without them; the row-level migration test uses the dirty data.
10. **An old-style update that changes the language** (the current screen offers it) removes the section and creates one in the new language in a single `save_concept` call. The row's `id` changes; the screen reloads the list after every save.
11. **`create_domain` and `update_domain` keep their signatures.** The sentence "every store method that writes takes the acting user, the origin and an optional comment" is read as: every method that writes concept data. Domains are not in the change log.

## What the later pull requests need from this one

The plan review checks the store interface against this list.

- **Pull request 2 (checker statuses):** `TerminologyStore.list_sections(domain_id, *, owner_id, language)` returns every term of each section with `usage_status`, `process_status`, `status_reason`, `case_sensitive` and `uid`; `is_enforced(process_status)`; `LanguageSection.definition`.
- **Pull request 3 (concept endpoints and screen):** `list_concepts`, `get_concept`, `create_concept`, `save_concept` (listed sections, optional complete domain list with the concept's number), `save_section`, `delete_concept`, `remove_concept_from_domain`; `TermInput` and `SectionInput` usable as request models; `TerminologyRuleError.rule` and `TerminologyConflictError.part` for the 409 message; `revision` on all three levels in every returned `Concept`; `Concept` serialisable as a response (`is_global`, `domain_ids`, sections, terms). It removes `get_concept_by_section`, the old `Term` model and the translation functions in `app/api/terminology.py`, and drops `terms_legacy`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/services/ownership.py` (modify) | The shared exception plus the visibility and write checks for rows with a nullable owner. |
| `backend/app/services/terminology/__init__.py` (create; replaces `terminology.py`) | Re-exports the public names so existing imports keep working. |
| `backend/app/services/terminology/model.py` (create) | Pick-lists, `Actor`, `Domain`, `Concept`, `LanguageSection`, `ConceptTerm`, the input models, `TerminologyRuleError`, `section_label`. No SQL. |
| `backend/app/services/terminology/schema.py` (create) | The schema text, the required-schema map, the domain migration that exists today, schema verification. |
| `backend/app/services/terminology/changes.py` (create) | `diff` (entries from a concept before and after) and `write` (insert entries). The only place that inserts into `terminology_changes`. |
| `backend/app/services/terminology/rows.py` (create) | SQL that reads and writes concept, section, term and link rows. No rules, no logging. Used by the store and the migration. |
| `backend/app/services/terminology/migration.py` (create) | Legacy `terms` rows to concepts; rename to `terms_legacy`. |
| `backend/app/services/terminology/store.py` (create; from `terminology.py`) | `TerminologyStore`: domains, concept reads, concept writes; locking and the rules. |
| `backend/app/api/terminology.py` (modify) | Unchanged endpoints; old-style `Term` model and the translation to and from sections. |
| `backend/app/checkers/terminology.py` (modify) | Reads sections; rule id from the term's uid. |
| `backend/app/services/seed.py` (modify) | Seeds concepts through the store with origin `seed`. |
| `backend/app/manage_import.py` (modify) | Table lists. |
| `backend/tests/terminology_baseline.py`, `tests/data/terminology_baseline.json`, `tests/test_terminology_baseline.py` (create) | Check results recorded on the old code, compared on the new. |
| `backend/tests/terminology_helpers.py` (create) | `add_term` (an old-style term through the new store) and `changes` (read the log). |
| `backend/tests/test_terminology_model.py`, `test_terminology_changes.py`, `test_terminology_store.py`, `test_terminology_concurrency.py`, `test_terminology_migration.py` (create) | One file per module under test. |
| `backend/tests/test_terminology.py` (modify) | Keeps the domain and checker tests; the old term-store tests leave. |
| `docs/backend-architecture.md` (modify) | Terminology and Ownership sections. |

---

### Task 1: Record today's check results

Runs on the unchanged code, so the recorded file is the old behaviour by construction.

**Files:**
- Create: `backend/tests/terminology_baseline.py`, `backend/tests/data/terminology_baseline.json`, `backend/tests/test_terminology_baseline.py`

**Interfaces:**
- Produces:
  - `BASELINE_DOMAINS: list[BaselineDomain]` where `BaselineDomain` is a frozen dataclass `(name: str, is_global: bool, terms: list[BaselineTerm])` and `BaselineTerm` is `(language: Language, preferred: str, forbidden_variants: list[str], definition: str, case_sensitive: bool)`.
  - `BASELINE_TEXTS: dict[Language, str]`: one text per language.
  - `normalise(findings: list[dict]) -> list[dict]`: keeps `severity`, `category`, `source`, `message`, `suggestions`, `span`; drops `id` and `rule_id`; sorts by `(span.start, span.end, message)`.
  - `load_golden() -> dict[str, list[dict]]`, keyed `"<domain name>/<language>"`.

- [ ] **Step 1: Write the data module.** Two domains: `"Baseline global"` (global) and `"Baseline own"` (owned by the admin, id 1). Between them, at least: two terms per Latin-script language (en, de, fr, es, it) and one each for ja and zh; one case-sensitive term with a variant that differs only in case (`GitHub` / `Github`); one case-sensitive term whose preferred wording is lower case (`sign in`), with a text that has it capitalised at a sentence start and mid-sentence; one term with two variants; one with a definition and one without. No duplicate or empty variant and none equal to its preferred wording (reading 9). Each text contains every variant of its language at least once, one correctly written preferred term, and one wrongly cased one.

- [ ] **Step 2: Write the test through the HTTP API.**

```python
def test_api_path_matches_golden(tmp_path):
    client = _client(tmp_path)          # Settings(seed_terminology=False), admin headers
    ids = _create_through_api(client)   # POST /api/domains, POST /api/domains/{id}/terms
    actual = {
        f"{d.name}/{language.value}": normalise(
            client.post("/api/checks", json={
                "text": BASELINE_TEXTS[language], "language": language.value,
                "domain_ids": [ids[d.name]], "checkers": ["terminology"],
            }).json()["findings"])
        for d in BASELINE_DOMAINS for language in Language
    }
    if os.environ.get("FW_UPDATE_TERMINOLOGY_BASELINE"):
        GOLDEN_PATH.write_text(json.dumps(actual, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    assert actual == load_golden()
```

`POST /api/domains` always creates an owned domain, so both baseline domains are owned here. `is_global` matters only in the migration test of Task 11.

- [ ] **Step 3: Record.** Run `FW_UPDATE_TERMINOLOGY_BASELINE=1 rtk proxy uv run pytest tests/test_terminology_baseline.py -q`, then without the variable. Expected: PASS both times. Open the JSON file and confirm by reading that every language has at least one finding, that the `Github` finding and both casing findings (mid-sentence yes, sentence start no) are as designed.

- [ ] **Step 4: Commit.** `test(terminology): record check results before the concept model`

---

### Task 2: Ownership checks in one place

**Files:**
- Modify: `backend/app/services/ownership.py`, `backend/app/services/terminology.py` (domain methods only)
- Test: `backend/tests/test_ownership_rules.py` (create)

**Interfaces:**
- Produces, in `app/services/ownership.py`:
  - `GLOBAL_READ_ONLY_MESSAGE = "Only admins can change built-in items"`
  - `visible_clause(column: str = "owner_id") -> str` returning `"(<column> IS NULL OR <column> = ?)"`
  - `is_visible(row_owner_id: int | None, *, user_id: int | None) -> bool`: true for a global row and for the owner's own row; a `user_id` of `None` sees global rows only.
  - `require_writable(row_owner_id: int | None, *, is_admin: bool) -> None`: raises `GlobalReadOnlyError(GLOBAL_READ_ONLY_MESSAGE)` for a global row and a non-admin.

- [ ] **Step 1: Write the failing tests** in `tests/test_ownership_rules.py`: `test_visible_clause_names_the_column` (`visible_clause("d.owner_id") == "(d.owner_id IS NULL OR d.owner_id = ?)"`), `test_global_row_is_visible_to_everyone_including_no_user`, `test_owned_row_is_visible_to_its_owner_only` (owner 2, user 1 and user `None`: false), `test_global_row_is_writable_by_admins_only`, `test_owned_row_is_writable_without_admin`.
- [ ] **Step 2:** Run them. Expected: FAIL (import error).
- [ ] **Step 3:** Implement the three functions and the constant.
- [ ] **Step 4:** In `TerminologyStore`, replace the inline domain checks: the SQL fragments `(owner_id IS NULL OR owner_id = ?)` in `list_domains`, `get_domain` and `_visible_domain_row` with `visible_clause()`, and the two `if current.is_global and not is_admin: raise …` blocks in `update_domain` and `delete_domain` with `require_writable(current.owner_id, is_admin=is_admin)`. The term methods stay as they are; Task 9 deletes them.
- [ ] **Step 5:** Run the gate. Mutation: make `require_writable` a no-op; `test_domain_visibility_and_admin_rule` must fail.
- [ ] **Step 6: Commit.** `refactor(ownership): shared visibility and write checks`

---

### Task 3: Package, models and schema

The old `terms` table and the old term methods stay in place and working until Task 9.

**Files:**
- Create: `backend/app/services/terminology/{__init__,model,schema,store}.py` (move `terminology.py` to `terminology/store.py` with `git mv`, then split)
- Test: `backend/tests/test_terminology_model.py` (create), `backend/tests/test_terminology_store.py` (create, schema tests only for now)

**Interfaces:**
- Produces, in `model.py`:

```python
class UsageStatus(StrEnum): PREFERRED, ADMITTED, DEPRECATED, FORBIDDEN       # values as in Global Constraints
class ProcessStatus(StrEnum): CANDIDATE, ACTIVE
PROCESS_STATUS_ENFORCED: dict[ProcessStatus, bool] = {ProcessStatus.CANDIDATE: False, ProcessStatus.ACTIVE: True}
def is_enforced(status: ProcessStatus) -> bool
class PartOfSpeech(StrEnum): NOUN, VERB, ADJECTIVE, ADVERB, PROPER_NOUN, OTHER
class Origin(StrEnum): MANUAL, EXTRACTION, IMPORT, MIGRATION, SEED
class Action(StrEnum): CREATED, EDITED, DELETED, ADDED_TO_DOMAIN, REMOVED_FROM_DOMAIN, CARRIED_OVER

@dataclass(frozen=True)
class Actor:
    user_id: int | None          # written to the log and to created_by / modified_by
    is_admin: bool
    origin: Origin = Origin.MANUAL
    @classmethod
    def system(cls, origin: Origin) -> "Actor"   # user_id None, is_admin True

class ConceptTerm(BaseModel):
    id: int; uid: str; text: str
    usage_status: UsageStatus; process_status: ProcessStatus
    status_reason: str = ""; context: str = ""; source: str = ""
    part_of_speech: PartOfSpeech | None = None   # stored as '' when None
    case_sensitive: bool = False
    revision: int = 1
    created_at: str | None = None; created_by: int | None = None
    modified_at: str | None = None; modified_by: int | None = None

class LanguageSection(BaseModel):
    id: int; language: Language; definition: str = ""
    revision: int = 1
    created_at, created_by, modified_at, modified_by   # as on ConceptTerm
    terms: list[ConceptTerm]                     # ascending id (creation order)

class Concept(BaseModel):
    id: int; uid: str
    owner_id: int | None = Field(default=None, exclude=True)
    is_global: bool                              # computed field, as on Domain
    domain_ids: list[int]                        # ascending
    sections: list[LanguageSection]              # in the order of the Language enum
    revision: int = 1
    created_at, created_by, modified_at, modified_by   # as on ConceptTerm

class TermInput(BaseModel):
    id: int | None = None
    text: str                                    # validator: must contain a non-whitespace character; stored as given
    usage_status: UsageStatus
    process_status: ProcessStatus = ProcessStatus.ACTIVE
    status_reason: str = ""; context: str = ""; source: str = ""
    part_of_speech: PartOfSpeech | None = None
    case_sensitive: bool = False
    @classmethod
    def from_term(cls, term: ConceptTerm) -> "TermInput"

class SectionInput(BaseModel):
    language: Language
    id: int | None = None                        # the section's id and number as read;
    revision: int | None = None                  # both None: the language must not exist yet
    definition: str = ""; terms: list[TermInput]
    @classmethod
    def from_section(cls, section: LanguageSection) -> "SectionInput"   # carries the section's id and revision

class TerminologyRuleError(Exception):
    def __init__(self, rule: str, message: str) -> None   # .rule holds the code

class TerminologyConflictError(TerminologyRuleError):     # rule "conflict"
    def __init__(self, part: str, message: str) -> None   # .part: a language value, or "links"
# rule codes: "duplicate_language", "no_section", "unknown_term", "duplicate_term", "duplicate_text",
# "second_preferred", "no_domain", "unknown_domain", "domain_owner_mismatch"

def section_label(section: LanguageSection) -> str
```

  `Domain` moves to `model.py` unchanged. `section_label` implements steps 1 to 3 of spec 5.5: the enforced preferred term; otherwise the first enforced admitted term; otherwise the first of all remaining terms. "First" is by `(text.casefold(), text)`.
- Produces, in `schema.py`: `SCHEMA: str`, `REQUIRED_SCHEMA: dict[str, list[tuple[str, str]]]`, `migrate_domains(conn) -> None` (today's `_migrate` body, unchanged), `SEED_DOMAIN_NAME`.
- `__init__.py` re-exports: everything above, `TerminologyStore`, the old `Term` (until Task 9), and `SEED_DOMAIN_NAME` also under its old name `_SEED_DOMAIN_NAME` (a test imports it).

- [ ] **Step 1: Move and split without behaviour change.** `git mv app/services/terminology.py app/services/terminology_store.py && mkdir app/services/terminology && git mv app/services/terminology_store.py app/services/terminology/store.py`; move `Domain` to `model.py`, the schema text and `_migrate` to `schema.py`; write `__init__.py`. Run the gate: PASS, no test edited.

- [ ] **Step 2: Write the failing model tests** in `tests/test_terminology_model.py`:
  - `test_every_process_status_declares_whether_it_is_enforced`: `set(PROCESS_STATUS_ENFORCED) == set(ProcessStatus)`; `is_enforced(ACTIVE)` true, `is_enforced(CANDIDATE)` false.
  - `test_pick_list_values`: the exact value lists from Global Constraints for all five enums.
  - `test_term_text_must_contain_a_visible_character`: `TermInput(text="  ", usage_status="preferred")` raises `ValidationError`; `TermInput(text=" login ", …).text == " login "`.
  - `test_unknown_pick_list_value_is_rejected`: `usage_status="banned"`, `process_status="trial"`, `part_of_speech="article"` each raise `ValidationError`.
  - `test_concept_hides_owner_id_and_reports_is_global`: `model_dump()` has `is_global` and no `owner_id`.
  - `test_section_label_order`, parametrised: active preferred wins over an alphabetically earlier admitted term; with only a candidate preferred and two active admitted terms `"beta"`, `"Alpha"` the label is `"Alpha"`; with only forbidden terms `"zeta"`, `"eta"` the label is `"eta"`.
  - `test_input_from_model_round_trip`: `SectionInput.from_section(section)` carries the language, the section's `id` and `revision`, the definition and each term's id and eight fields.
  - `test_conflict_error_is_a_rule_error`: `TerminologyConflictError("en", "…")` has `rule == "conflict"` and `part == "en"` and is caught by `except TerminologyRuleError`.
- [ ] **Step 3:** Run them: FAIL. Implement `model.py`. Run: PASS.

- [ ] **Step 4: Write the failing schema tests** in `tests/test_terminology_store.py` (uses the `db` fixture, so both backends):
  - `test_schema_creates_the_concept_tables`: after `TerminologyStore(db)`, `table_columns` for `concepts`, `concept_domains`, `concept_languages`, `concept_terms`, `terminology_changes` equals the column sets of spec 5.2 and 7 exactly, including `revision` on the first, third and fourth and the four created and modified columns on `concept_languages`.
  - `test_constructing_the_store_twice_is_idempotent`.
  - `test_section_language_is_unique_per_concept`: a second `concept_languages` row with the same `(concept_id, language)` raises `UniqueViolationError`.
  - `test_deleting_a_concept_row_cascades`: direct SQL insert of concept, link, section, term; `DELETE FROM concepts` leaves zero rows in the other three.
- [ ] **Step 5:** Run: FAIL. Add to `SCHEMA` (keep `domains` and, for now, `terms`):

```sql
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    owner_id INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, created_by INTEGER, modified_at TEXT, modified_by INTEGER
);
CREATE TABLE IF NOT EXISTS concept_domains (
    concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    PRIMARY KEY (concept_id, domain_id)
);
CREATE INDEX IF NOT EXISTS idx_concept_domains_domain ON concept_domains(domain_id);
CREATE TABLE IF NOT EXISTS concept_languages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    definition TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, created_by INTEGER, modified_at TEXT, modified_by INTEGER,
    UNIQUE (concept_id, language)
);
CREATE TABLE IF NOT EXISTS concept_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    section_id INTEGER NOT NULL REFERENCES concept_languages(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    usage_status TEXT NOT NULL,
    process_status TEXT NOT NULL,
    status_reason TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    part_of_speech TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, created_by INTEGER, modified_at TEXT, modified_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_concept_terms_section ON concept_terms(section_id);
CREATE TABLE IF NOT EXISTS terminology_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT NOT NULL,
    at TEXT NOT NULL,
    user_id INTEGER,
    origin TEXT NOT NULL,
    action TEXT NOT NULL,
    concept_id INTEGER NOT NULL,
    concept_uid TEXT NOT NULL,
    term_id INTEGER, term_uid TEXT, term_text TEXT, term_language TEXT,
    concept_labels TEXT NOT NULL DEFAULT '{}',
    changes TEXT NOT NULL DEFAULT '[]',
    comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_terminology_changes_concept ON terminology_changes(concept_id);
CREATE INDEX IF NOT EXISTS idx_terminology_changes_term ON terminology_changes(term_id);
```

  `REQUIRED_SCHEMA` gains the five tables with empty column lists. If Postgres rejects a column name, stop and report; do not rename on your own.
- [ ] **Step 6:** Run the gate on both backends. **Commit.** `feat(terminology): package, concept models and tables`

---

### Task 4: Change log: entries from a comparison

**Files:**
- Create: `backend/app/services/terminology/changes.py`
- Test: `backend/tests/test_terminology_changes.py`

**Interfaces:**
- Consumes: `Concept`, `LanguageSection`, `ConceptTerm`, `Action`, `Actor`, `section_label` (Task 3).
- Produces:

```python
TERM_FIELDS = ("text", "usage_status", "process_status", "status_reason",
               "context", "source", "part_of_speech", "case_sensitive")

@dataclass(frozen=True)
class Entry:
    action: Action
    concept_id: int; concept_uid: str
    term_id: int | None; term_uid: str | None
    term_text: str | None; term_language: str | None
    concept_labels: dict[str, str]
    changes: list[dict]

def diff(before: Concept | None, after: Concept | None, *,
         domain_names: dict[int, str],
         initial_action: Action = Action.CREATED) -> list[Entry]

def write(conn, entries: list[Entry], *, batch: str, at: str,
          actor: Actor, comment: str = "") -> None
```

`diff` rules (spec 7, readings 5 and 6):

| Situation | Entries |
|---|---|
| `before is None` | one concept entry with `initial_action`: per section `{"field": "definition", "language": l, "old": None, "new": text}`, per domain `{"field": "domain", "old": None, "new": {"id": i, "name": n}}`; one entry per term with `initial_action` and all `TERM_FIELDS` as `{"field": f, "old": None, "new": v}` |
| `after is None` | the same with `Action.DELETED`, values under `old`, `new` None |
| both present | concept `EDITED` if any definition differs (absent section = `""`), listing only the differing ones with `language`; one `REMOVED_FROM_DOMAIN` per removed link and one `ADDED_TO_DOMAIN` per added link, each with a single `domain` change; per term: `CREATED` (id only in `after`), `DELETED` (id only in `before`), `EDITED` listing only the differing fields |
| equal | `[]` |

Values in `changes`: enum values as strings, `part_of_speech` as `""` when none, `case_sensitive` as a JSON boolean. `concept_labels` is `{language: section_label(section)}` of `after`, or of `before` when `after` is None, and is the same on every entry of the result. `term_text` and `term_language` come from `after`, or from `before` for a deleted term. Order: the concept's `CREATED`/`EDITED`/`DELETED` entry, then removed links by domain id, then added links, then terms by section order and term id. `revision`, `created_*`/`modified_*`, ids and uids are never compared.

`write` inserts one row per entry with `user_id = actor.user_id`, `origin = actor.origin.value`, JSON columns via `json.dumps(…, ensure_ascii=False)`.

- [ ] **Step 1: Write the failing tests.** A module-level builder `concept(**overrides)` returns a `Concept` with id 7, domains `[3]`, an `en` section (definition `"d"`) with an active preferred `"sign in"` (id 11) and an active forbidden `"login"` (id 12), and a `de` section (definition `"a"`) with an active preferred `"anmelden"` (id 13). `NAMES = {3: "Cloud", 4: "Legal"}`.
  - `test_created_lists_every_initial_value`: `diff(None, c)` gives 4 entries; entry 0 is `CREATED` with `term_id is None` and exactly the changes `definition/en`, `definition/de`, `domain {id 3, name "Cloud"}`; entry 1 has `term_text == "sign in"`, `term_language == "en"` and 8 changes with `old is None`.
  - `test_carried_over_uses_the_given_action`: `initial_action=Action.CARRIED_OVER` on all 4.
  - `test_deleted_lists_the_last_state_as_old_values`, and `concept_labels == {"en": "sign in", "de": "anmelden"}` on every entry.
  - `test_no_difference_gives_no_entries`, also when only `modified_at` or `revision` differs.
  - `test_several_fields_of_one_term_are_one_entry`: usage status and reason of term 12 changed gives exactly one entry, `EDITED`, `term_id == 12`, two changes with old and new.
  - `test_definition_change_is_logged_on_the_concept_with_its_language`.
  - `test_new_section_with_empty_definition_logs_only_its_terms`.
  - `test_removed_section_logs_its_definition_and_its_terms`: `{"field": "definition", "language": "de", "old": "…", "new": ""}` plus a `DELETED` term entry whose `term_language == "de"`.
  - `test_domain_links_are_one_entry_each`: domains `[3]` to `[4]` gives `REMOVED_FROM_DOMAIN` (id 3, name `"Cloud"` under `old`) then `ADDED_TO_DOMAIN` (id 4 under `new`).
  - `test_labels_describe_the_state_after_the_change`: renaming the preferred term gives the new wording in `concept_labels` and in `term_text`.
  - `test_no_statement_updates_or_deletes_log_entries`: over every `.py` file in `app/services/terminology/`, the pattern `(UPDATE|DELETE\s+FROM)\s+terminology_changes` (case-insensitive) has no match, and `INSERT INTO terminology_changes` occurs in `changes.py` only.
  - `test_write_inserts_one_row_per_entry` (fixture `db`): after `write(conn, diff(None, c), batch="b1", at="2026-01-01T00:00:00+00:00", actor=Actor(user_id=5, is_admin=False), comment="why")`, four rows with that batch, user 5, origin `manual`, comment `"why"`; `json.loads(row["changes"])` equals the entry's changes.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement. **Step 4:** Run the gate on both backends.
- [ ] **Step 5: Commit.** `feat(terminology): derive change-log entries from before and after`

---

### Task 5: Store: read, create and delete concepts

**Files:**
- Modify: `backend/app/services/terminology/store.py`
- Create: `backend/app/services/terminology/rows.py`, `backend/tests/terminology_helpers.py`
- Test: `backend/tests/test_terminology_store.py`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces, on `TerminologyStore`:

```python
def list_concepts(self, domain_id: int, *, owner_id: int) -> list[Concept] | None   # None: domain not visible; ascending concept id
def get_concept(self, concept_id: int, *, owner_id: int) -> Concept | None
def list_sections(self, domain_id: int, *, owner_id: int, language: Language) -> list[LanguageSection] | None
def create_concept(self, domain_id: int, sections: list[SectionInput], *,
                   actor: Actor, comment: str = "") -> Concept | None
def delete_concept(self, concept_id: int, *, actor: Actor, comment: str = "") -> bool
```

  Module-level in `store.py`: `def _utcnow() -> str` (`datetime.now(UTC).isoformat(timespec="seconds")`), patched by tests.
  Private in `store.py`, reused by Tasks 6 and 7: `_lock(conn, *, domain_ids=(), concept_ids=())` and `_validate(sections: list[SectionInput], current: Concept | None) -> None`.
- Produces, in `rows.py` (also used by Task 11):

```python
def load_concept(conn, concept_id: int) -> Concept | None
def load_concepts(conn, concept_ids: list[int]) -> list[Concept]          # ascending id; a fixed number of queries, not one per concept
def insert_concept(conn, *, owner_id: int | None, now: str | None, user_id: int | None) -> int
def set_links(conn, concept_id: int, domain_ids: list[int]) -> None       # makes the links equal to the list
def apply_sections(conn, concept_id: int, current: Concept | None, sections: list[SectionInput], *,
                   now: str | None, user_id: int | None,
                   new_section_ids: dict[Language, int] | None = None) -> None   # only the migration passes ids
def touch_concept(conn, concept_id: int, *, now: str, user_id: int | None) -> None   # revision + 1, modified_at, modified_by
def domain_names(conn, domain_ids: list[int]) -> dict[int, str]
```
- Produces, in `tests/terminology_helpers.py`:
  - `add_term(store, domain_id, *, language, preferred, forbidden_variants=(), definition="", case_sensitive=False, actor=Actor(user_id=1, is_admin=True)) -> Concept`: one concept with one section, the preferred term active preferred, each variant active forbidden, all with the given `case_sensitive`.
  - `changes(db) -> list[dict]`: every `terminology_changes` row in id order, `changes` and `concept_labels` decoded.

**Rules this task implements**

- `_lock` runs `UPDATE domains SET name = name WHERE id = ?` for each domain id ascending, then `UPDATE concepts SET uid = uid WHERE id = ?` for each concept id ascending. In every writing method it is the first statement, before any read (reading 3).
- `_validate` (spec 5.3) checks the state that would result from writing the given sections over `current` (a section without terms removes that language; a language not given stays as it is). It raises `TerminologyRuleError` for two given sections with the same language (`duplicate_language`), no section left (`no_section`), a term id that is not a term of that language's current section (`unknown_term`), the same term id given twice (`duplicate_term`), two terms with the same text in a section (`duplicate_text`), more than one term that is preferred and enforced in a section (`second_preferred`). Each message names the rule in one plain sentence, for example "A language can have only one active preferred term."
- `apply_sections` writes the given sections over `current`: a given section without terms is deleted; in the others, missing terms are deleted, changed terms and definitions updated, new terms and sections inserted (uid `str(uuid.uuid4())`). A section of `current` that is not given is left alone. Sections are matched by language, terms by id. Inserted rows get `revision` 1 and `created_*` and `modified_*` from `now` and `user_id`. A changed term gets `revision = revision + 1` and new `modified_*`; so does a section whose definition changed or in which a term was added, changed or removed (spec 5.7). An unchanged row is not written.
- A writing method, in this order: `_lock`; load the current state; return `None`/`False` if not visible to `actor.user_id`; `require_writable(owner, is_admin=actor.is_admin)`; `_validate`; `apply_sections` (and `set_links` where links change); load the new state; `entries = changes.diff(before, after, domain_names=…)`; if there are entries, `changes.write(…)` with a new batch (`uuid.uuid4().hex`) and the same `now`; if `before` exists and the links or the set of languages changed, `touch_concept` (a new concept stays at 1); return the state as loaded after all of that, so that the returned concept carries the new numbers and modified fields. Task 6 adds the version check between `require_writable` and `_validate`. Always call it as `changes.write`, through the module, so that a test can patch it.
- Visibility and write permission of concepts and domains go through `ownership.visible_clause`, `ownership.is_visible` and `ownership.require_writable` only; the new code contains no inline visibility or admin check. (The old term methods keep theirs until Task 9 deletes them. Comparing a domain's owner with a concept's for `domain_owner_mismatch` is a rule, not a visibility check.)
- `create_concept`: the concept takes the domain's `owner_id`; every row starts with `revision` 1; `created_*` and `modified_*` are both set (to `None` user for a system actor). A `revision` given on an input section is ignored here.
- `delete_concept`: logs `diff(before, None)` and deletes the concept row (links, sections and terms cascade).

- [ ] **Step 1: Write the helpers** (`add_term`, `changes`).
- [ ] **Step 2: Write the failing tests** (fixture `store`, both backends; `d = store.create_domain("Cloud", owner_id=1)`; `ME = Actor(user_id=1, is_admin=False)`):
  - `test_create_concept_returns_the_stored_shape`: two sections given as `[de, en]` come back as `[en, de]`; terms in input order; each `uid` is a distinct UUID; `domain_ids == [d.id]`; `created_by == 1` and `revision == 1` on the concept, both sections and every term.
  - `test_concept_takes_the_owner_of_its_domain`: in a global domain as admin, `is_global is True`; in an own domain, false.
  - `test_create_in_an_invisible_domain_returns_none` (domain of owner 2, actor user 1) and writes nothing.
  - `test_create_in_a_global_domain_needs_admin`: `GlobalReadOnlyError`.
  - `test_get_and_list_respect_visibility`: owner 2 gets `None` for owner 1's concept and for `list_concepts` on owner 1's domain; everyone reads a global concept.
  - `test_list_sections_returns_one_language`: sections of two concepts in `en`, none of the `de` ones, every term present including a candidate.
  - `test_rules_on_create`, parametrised over `(sections, rule)`: `[]` gives `no_section`; a section with `terms=[]` only gives `no_section`; two `en` sections give `duplicate_language`; two terms `"login"` give `duplicate_text`; two active preferred terms give `second_preferred`. Each asserts `exc.value.rule` and that no concept row exists afterwards.
  - `test_a_candidate_preferred_term_does_not_count`: one active and one candidate preferred term are accepted.
  - `test_text_differing_only_in_case_is_a_different_term`: `"Login"` and `"login"` are accepted.
  - `test_create_writes_one_batch`: `changes(db)` has one concept entry and one per term, one shared `batch`, `origin == "manual"`, `user_id == 1`, `action == "created"`, comment as passed.
  - `test_system_actor_logs_no_user`: `Actor.system(Origin.SEED)` gives `user_id is None`, `origin == "seed"`, `created_by is None`.
  - `test_delete_concept_removes_everything_and_logs_the_last_state`: rows gone from all four tables; entries `deleted` with `term_text` and `concept_labels` filled; a second delete returns `False`.
  - `test_delete_of_a_global_concept_needs_admin`; `test_delete_of_a_foreign_concept_returns_false`.
- [ ] **Step 3:** Run: FAIL. **Step 4:** Implement. **Step 5:** Mutation checks, each restored afterwards: remove the `second_preferred` check; remove the `require_writable` call in `delete_concept`; remove the visibility check in `get_concept`. Each must fail a named test. Then remove each remaining check in `_validate` once, one at a time, and list in the report which test failed for which.
- [ ] **Step 6:** Run the gate on both backends. **Commit.** `feat(terminology): create, read and delete concepts`

---

### Task 6: Store: save a concept and save a section

**Files:**
- Modify: `backend/app/services/terminology/store.py`, `backend/app/services/terminology/rows.py`
- Test: `backend/tests/test_terminology_store.py`

**Interfaces:**
- Produces:

```python
def save_section(self, concept_id: int, section: SectionInput, *,
                 actor: Actor, comment: str = "") -> Concept | None
def save_concept(self, concept_id: int, *, sections: list[SectionInput] = (),
                 domain_ids: list[int] | None = None, revision: int | None = None,
                 actor: Actor, comment: str = "") -> Concept | None
```

- `save_section` writes one language section and leaves the others and the links alone. It creates the section if the concept has none in that language. With `terms=[]` it removes the section and raises `no_section` if it was the last.
- `save_concept` writes several parts in one transaction and one batch (spec 9.2, 10 "Save all"): each listed section as `save_section` would, and, when `domain_ids` is given, the links as the complete list. **A section that is not listed is left untouched.** With `domain_ids=None` the links are left untouched. It locks the given domains, then the concept. Domain rules (spec 5.4): empty list raises `no_domain`; an id not visible to the actor raises `unknown_domain`; a domain whose `owner_id` differs from the concept's raises `domain_owner_mismatch`.
- **Version check (spec 5.7)**, after locking, loading, the visibility check and `require_writable`, before `_validate` and before any write. Each failure raises `TerminologyConflictError`:
  - for every listed section whose language the concept has: `section.id` and `section.revision` must both equal the stored values, otherwise `part` is the language value. The id is compared because a language that was removed and added again starts at 1 again, with a new id;
  - for every listed section whose language the concept does not have: `section.id` and `section.revision` must be `None`, otherwise `part` is the language value (the language was removed in the meantime). A listed section without them whose language exists is refused the same way (someone added it in the meantime);
  - when `domain_ids` is given: `revision` must equal the concept's number, otherwise `part` is `"links"`.
- **What increases (spec 5.7).** Term: one of its fields changed. Section: its definition changed, or a term in it was added, changed or removed. Concept: the links changed, or a section was added or removed. `rows.apply_sections` increases term and section numbers and sets their `modified_*`; the store calls `rows.touch_concept` only for a concept-level change. A save whose result equals the current state increases nothing and writes nothing.
- Both methods return `None` for a concept that is not visible and raise `GlobalReadOnlyError` for a global concept and a non-admin **before** the version check and before deciding whether anything changes.

- [ ] **Step 1: Write the failing tests.** Start each from `c = add_term(store, d.id, language=Language.EN, preferred="sign in", forbidden_variants=["login"], definition="d")`, with a clock fixture that patches `store._utcnow` and advances between saves. `en(c)` stands for `SectionInput.from_section` of the concept's `en` section, which carries its `revision`.
  - `test_save_section_edits_a_term_and_logs_one_entry`: change `login` to deprecated with a reason; one new entry, `edited`, two changes. On the returned concept and on a fresh `get_concept`: that term has `revision == 2`, `modified_at` the new time and `created_at` the old; the other term has `revision == 1` and its old `modified_at`; the section has `revision == 2` and the new `modified_at`; the concept has `revision == 1` and its old `modified_at`.
  - `test_definition_change_increases_the_section_only`: terms and concept keep number and `modified_at`.
  - `test_saving_the_current_state_changes_nothing`: `save_section(c.id, en(c), …)` after advancing the clock: `changes(db)` unchanged and `get_concept` equal to before, including every `revision` and `modified_at`. Same for `save_concept(c.id, sections=[en(c)], domain_ids=[d.id], revision=c.revision, …)`.
  - `test_out_of_date_section_is_refused`: save once, then save a different edit with the first `en(c)` again: `TerminologyConflictError`, `rule == "conflict"`, `part == "en"`; state and log unchanged since the first save.
  - `test_two_languages_saved_from_the_same_read_both_succeed`: from a concept with `en` and `de`, read once, save an `en` edit, then a `de` edit built from the same read.
  - `test_adding_a_language_needs_no_number_and_increases_the_concept`: `SectionInput(language=DE, terms=[…])` with `revision=None` creates the section with `revision == 1`, `created_by == 1`; the concept's `revision` is 2 and its `modified_at` new; the `en` section is untouched.
  - `test_two_different_languages_can_be_added_from_the_same_read`: add `de`, then `fr`, both with `revision=None`; both exist.
  - `test_adding_a_language_that_exists_meanwhile_is_refused`: add `de`, then add `de` again with `revision=None`: conflict with `part == "de"`.
  - `test_saving_a_language_removed_meanwhile_is_refused`: read a concept with `en` and `de`, remove `de` with its number, then save `de` with the old number: conflict with `part == "de"`, and `de` is not re-created.
  - `test_a_language_removed_and_added_again_refuses_the_old_copy`: read a concept with `en` and `de`; remove `de` and add it again (it is at `revision` 1 again, with a new id); a save and a removal built from the first read are both refused with `part == "de"`.
  - `test_removing_the_last_term_removes_the_section`: with an `en` and a `de` section (definition `"a"`), `save_section(…, SectionInput(language=DE, revision=<its number>, terms=[]))` leaves only `en`, logs the definition and the terms of `de`, and increases the concept's number.
  - `test_removing_a_section_with_an_out_of_date_number_is_refused`.
  - `test_removing_the_last_section_is_refused`: `no_section`, state unchanged.
  - `test_missing_term_is_deleted_and_new_term_is_created`: entries `deleted` and `created` in one batch; the new term has `revision == 1`.
  - `test_term_ids_survive_a_save`: an untouched term keeps `id`, `uid` and `revision`.
  - `test_two_terms_can_swap_their_wording_in_one_save` (reading 2).
  - `test_unknown_term_id_is_refused`: an id of a term of the `de` section sent in the `en` section, and an id of another concept: `unknown_term`.
  - `test_second_active_preferred_term_is_refused_on_save`.
  - `test_the_same_term_id_twice_is_refused`: two inputs with the id of `login`, different texts: `duplicate_term`, state unchanged.
  - `test_save_concept_leaves_unlisted_sections_alone`: a concept with `en` and `de`; `save_concept(c.id, sections=[<edited en>], …)` changes `en`; `de` keeps its content, `revision` and `modified_at`; the links are unchanged.
  - `test_save_concept_writes_several_parts_in_one_batch`: an `en` edit, a new `fr` section and `domain_ids=[d.id, d2.id]` with the concept's number: one batch containing the term entry, the `fr` term entries and one `added_to_domain`.
  - `test_changing_links_increases_the_concept_only`: `domain_ids=[d2.id]` logs `removed_from_domain` then `added_to_domain`; the concept's `revision` is 2; no section or term number changes; `list_concepts(d.id)` no longer contains it.
  - `test_out_of_date_links_are_refused`: change the links, then send links again with the old number: conflict with `part == "links"`. Also `domain_ids` given with `revision=None`.
  - `test_a_refused_part_refuses_the_whole_save`: `save_concept` with a valid `en` edit and out-of-date links: conflict, and the `en` edit is not stored.
  - `test_domain_rules`, parametrised: `[]` gives `no_domain`; a foreign owner's domain gives `unknown_domain`; a global domain for an own concept gives `domain_owner_mismatch`; an own domain for a global concept (as admin) gives `domain_owner_mismatch`.
  - `test_shared_concept_is_one_row_seen_from_both_domains`: after linking to `d` and `d2`, both `list_concepts` return the same `id`, and an edit through one is visible through the other.
  - `test_non_admin_cannot_save_a_global_concept_even_without_changes`, also with an out-of-date number (the refusal is `GlobalReadOnlyError`, not a conflict).
  - `test_failed_save_leaves_no_partial_write`: patch `changes.write` to raise; a `save_concept` that adds a `de` section and edits an `en` term raises; afterwards there is no `de` section, the `en` term and every number are unchanged and the log has no new entry.
  - `test_comment_is_stored_on_every_entry_of_the_batch`.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement, reusing `_lock`, `_validate`, the `rows` functions and `changes.diff`. **Step 4:** Mutation checks, one at a time, each with the test that failed named in the report: remove the section number comparison; remove the section id comparison; remove the "must be absent" comparison; remove the "must exist" comparison (a number sent for a language the concept no longer has); remove the links comparison; call `touch_concept` on every save; increase the section number on every save; delete unlisted sections in `save_concept`; remove each of the three domain rules; move `require_writable` after the version check; call `conn.commit()` right before `changes.write`.
- [ ] **Step 5:** Run the gate on both backends. **Commit.** `feat(terminology): save concepts and language sections`

---

### Task 7: Store: remove from a domain, delete a domain

**Files:**
- Modify: `backend/app/services/terminology/store.py`, `backend/app/api/terminology.py` (the one call to `delete_domain`)
- Test: `backend/tests/test_terminology_store.py`, `backend/tests/test_terminology.py` (two calls to `delete_domain`)

**Interfaces:**
- Produces:

```python
def remove_concept_from_domain(self, concept_id: int, domain_id: int, *,
                               actor: Actor, comment: str = "") -> bool
def delete_domain(self, domain_id: int, *, actor: Actor, comment: str = "") -> bool   # replaces (owner_id, is_admin)
```

- `remove_concept_from_domain`: `False` when the concept or the domain is not visible or they are not linked; `no_domain` when it is the concept's last link; otherwise deletes the link, increases the concept's number (`touch_concept`) and logs `removed_from_domain`. No version number is checked here or in `delete_domain` and `delete_concept` (spec 5.7).
- `delete_domain`, in one transaction and one batch (spec 5.4): lock the domain; read the linked concept ids and lock them; then read again and decide: a concept with no other domain is deleted (logged as in `delete_concept`), every other one loses the link (its number increases; logged `removed_from_domain`); finally delete the domain row. Visibility and the admin rule as today.
- The API call becomes `delete_domain(domain_id, actor=Actor(user_id=user.id, is_admin=user.is_admin))`.

- [ ] **Step 1: Write the failing tests.**
  - `test_remove_from_domain_deletes_the_link_only` (also: one `removed_from_domain` entry naming the domain by id and name; the concept's `revision` is one more than before the removal and no section number changed); `test_remove_from_the_last_domain_is_refused`; `test_remove_returns_false_when_not_linked`.
  - `test_delete_domain_deletes_concepts_that_are_in_no_other_domain`: concept A only in `d`, concept B in `d` and `d2`. Afterwards A is gone, B is in `d2` only with a `revision` one more than before; the log has one batch with A's `deleted` entries and B's `removed_from_domain` entry naming `d` by id and name.
  - `test_delete_domain_as_non_admin_on_a_global_domain_is_refused` and writes nothing.
  - `test_delete_empty_domain_writes_no_entry`.
  - Update the two existing `delete_domain` calls in `tests/test_terminology.py` to the new signature. `test_delete_domain_cascades_terms` still uses the old `create_term`; leave it for Task 9.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement. **Step 4:** Mutation: delete every linked concept regardless of other domains; the first delete-domain test must fail.
- [ ] **Step 5:** Run the gate on both backends, including `tests/test_terminology_api.py` and `tests/test_ownership.py` unchanged. **Commit.** `feat(terminology): domain links and logged domain deletion`

---

### Task 8: Simultaneous writes on Postgres

**Files:**
- Test: `backend/tests/test_terminology_concurrency.py` (create)

All three tests need Postgres and skip without `FW_TEST_DATABASE_URL`. Read `TestPostgresReservationConcurrency` in `tests/test_usage.py` first and follow its process handling exactly (spawn context, module-level worker, barrier, queue, terminate-and-join in `finally`, `dsn = pg_database._pool.conninfo`).

The version check is only sound together with the lock: the comparison must read the number after the concept row is locked. These tests pin that.

- [ ] **Step 1: The race** (spec 14).

```python
def _add_preferred_worker(dsn, concept_id, section, index, barrier, queue): ...
    # own PostgresDatabase and TerminologyStore; barrier.wait();
    # section is the model_dump() of SectionInput.from_section(<en section>), read once by the parent,
    # so every worker carries the same revision; the worker appends
    # TermInput(text=f"preferred {index}", usage_status=UsageStatus.PREFERRED) and calls save_section.
    # queue.put("saved") or, on TerminologyConflictError, queue.put("conflict"); close the database in finally

def test_of_simultaneous_saves_with_one_number_exactly_one_succeeds(pg_database):
    # setup: one concept whose en section has a single forbidden term
    # 8 processes; all exit codes 0
    # exactly one "saved", seven "conflict"
    # the section has exactly one term that is preferred and active, and revision == 2
```

- [ ] **Step 2: The same rule, with a fixed order of the two transactions.** The race depends on timing, so this test is the binding guard:

```python
def test_a_save_compares_the_number_only_after_locking_the_concept(pg_database):
    # setup as above; section = SectionInput.from_section(<en section>) plus a new preferred term
    # main: conn = pg_database.raw_connect()
    #       conn.execute("UPDATE concepts SET uid = uid WHERE id = ?", (c.id,))
    #       conn.execute("UPDATE concept_languages SET revision = revision + 1 WHERE id = ?", (<en id>,))   # not committed
    # worker thread: store.save_section(c.id, section, actor=...), keeping the result or the exception
    # worker.join(timeout=1.0); assert worker.is_alive()
    # main: conn.commit(); conn.close(); worker.join(timeout=10); assert not worker.is_alive()
    # assert: the worker raised TerminologyConflictError; the section has no preferred term
```

  With the lock taken first, the worker loads the section after the main transaction committed and sees the new number. Without it, the worker has compared against the old number and written its terms before it blocks on the section row, and then completes.

- [ ] **Step 3: Mutation.** Remove the concept update in `_lock`. The fixed-order test must fail (the worker's save succeeds). Run the race test five times with `PG_ENV` and report how many runs failed; it is expected to fail in most with more than one "saved", but it is not the binding guard. Restore. The mutation only proves something if the section's number is increased unconditionally (`SET revision = revision + 1`), which Task 5 prescribes; a conditional update would hide a missing lock.

- [ ] **Step 4: The domain lock** (reading 3), deterministic, one process:

```python
def test_creating_a_concept_waits_for_a_domain_being_deleted(pg_database):
    # main: conn = pg_database.raw_connect();
    #       conn.execute("UPDATE domains SET name = name WHERE id = ?", (d.id,))   # not committed
    # worker thread: result = store.create_concept(d.id, [...], actor=...)
    # worker.join(timeout=1.0); assert worker.is_alive()          # blocked on the domain row
    # main: conn.execute("DELETE FROM domains WHERE id = ?", (d.id,)); conn.commit(); conn.close()
    # worker.join(timeout=10); assert not worker.is_alive(); assert result is None
    # assert SELECT COUNT(*) FROM concepts == 0
```

- [ ] **Step 5: Mutation.** Remove the domain updates in `_lock`: the `is_alive()` assertion must fail. Restore.
- [ ] **Step 6:** Run the gate on both backends. **Commit.** `test(terminology): simultaneous saves and domain deletion on Postgres`

---

### Task 9: Checker, old endpoints and seeding move to the concept store

One task and one commit: the checker and the endpoints must switch together, or the checks would read a table the endpoints no longer write.

**Files:**
- Modify: `backend/app/checkers/terminology.py`, `backend/app/api/terminology.py`, `backend/app/services/seed.py`, `backend/app/services/terminology/{store,__init__}.py`
- Test: `backend/tests/test_terminology.py`, `backend/tests/test_terminology_api.py` (additions only), `backend/tests/test_seed.py`, `backend/tests/test_import_postgres.py` (one setup call)

**Interfaces:**
- Consumes: `list_sections`, `list_concepts`, `create_concept`, `save_concept`, `save_section`, `delete_concept`, `is_enforced`, `SectionInput.from_section`, `add_term`.
- Produces: `TerminologyStore.get_concept_by_section(section_id: int, *, owner_id: int) -> Concept | None` (removed again in the third pull request; its docstring says so).
- Removes from the store: `list_terms`, `get_term`, `create_term`, `update_term`, `delete_term`, `_row_to_term`, and `_visible_domain_row` if unused. The `Term` model moves to `app/api/terminology.py`; `app.services.terminology` no longer exports it.
- `TerminologyChecker.check(text, language, domain_id, *, owner_id) -> list[Finding]` keeps its signature.
- The `terms` table stays in `SCHEMA`, empty and unused, until Task 11.

**Checker (spec 9.1, last paragraph; reading 8):**
- Per section: the preferred term is the one that is preferred and enforced. Without one, the section yields nothing. The forbidden terms are those that are forbidden and enforced, in creation order.
- Sections are processed in the order of their preferred wording (`sorted` by text). This is today's `ORDER BY preferred` on SQLite; on Postgres the database's collation ordered the rows, which only affects the order of two findings on the same span.
- A forbidden term is matched with **its own** `case_sensitive`; the casing check uses the preferred term's.
- Finding: message, severity, category, source and suggestions exactly as today (`Use '<preferred>' instead of '<matched>'.`, then the definition). `rule_id` is `f"terminology.{term.uid}"`, where `term` is the forbidden term that matched or, for a casing finding, the preferred term.
- Admitted and deprecated terms and candidates are not handled; the second pull request adds them.
- `_sentence_start`, `_casing_ok`, `_without_overlaps` and the three matching strategies stay as they are.

**Endpoints (spec 9.1):**

| Endpoint | Behaviour |
|---|---|
| `GET /domains/{id}/terms` | `list_concepts`; every section (of the given language, if any) that has an enforced preferred term becomes a `Term`: `id` = section id, `domain_id` = the path's domain, `preferred` = that term's text, `forbidden_variants` = the forbidden terms' texts in creation order, `definition`, `case_sensitive` = the preferred term's. Sorted by `preferred`. |
| `POST /domains/{id}/terms` | `create_concept` with one section: the preferred term (active, preferred) and one active forbidden term per cleaned variant, all with the body's `case_sensitive`. |
| `PUT /terms/{id}` | `get_concept_by_section`; build the section from the current one (`SectionInput.from_section`, which carries its number) and the body's non-null fields; `save_section`. A new `preferred` renames the preferred term (same term id). `forbidden_variants` keeps the terms whose text is in the cleaned list, removes the others, adds the new ones in list order. `case_sensitive` is set on every term of the section. A different `language`: one `save_concept` call with two sections: the current one with its number and `terms=[]`, and a new one in the new language (no number) with all terms recreated (reading 10). The response's `domain_id` is the concept's first domain id. |
| `DELETE /terms/{id}` | `delete_concept` when the section is the concept's only one, otherwise `save_section` with the section's number and `terms=[]`. |

"Cleaned" means: variants that are empty or whitespace only, repeat an earlier one, or equal the preferred wording are dropped silently. In `PUT` the cleaning is applied to the resulting variant list (from the body, or the current one) against the resulting preferred wording, so renaming the preferred term to the text of a current variant drops that variant instead of failing. Every call passes `Actor(user_id=user.id, is_admin=user.is_admin)`. Status codes as today: `None`/`False` from the store is 404, `GlobalReadOnlyError` is 403; new: `TerminologyRuleError`, including the conflict, is 409 with its message (reading 4). The feature gate and `validate_name` stay where they are.

- [ ] **Step 1: Switch the checker tests' setup.** In `TestChecker`, `TestPreferredCasing` and `TestCjkChecker` of `tests/test_terminology.py`, replace each `store.create_term(domain.id, owner_id=1, is_admin=True, language=…, preferred=…, …)` with `add_term(store, domain.id, language=…, preferred=…, …)`. No assertion changes. Add:
  - `test_rule_id_is_the_uid_of_the_matched_term`: for a forbidden match the forbidden term's uid, for a casing finding the preferred term's.
  - `test_forbidden_term_uses_its_own_case_sensitivity`: a section built with `create_concept` where the preferred term is case-insensitive and the forbidden term `"Github"` is case-sensitive: `"github"` is not flagged, `"Github"` is.
  - `test_section_without_preferred_term_yields_nothing`.
- [ ] **Step 2: Write the failing endpoint tests** in `tests/test_terminology_api.py` (existing tests stay byte-identical):
  - `test_variants_are_cleaned`: POST with `["login", "", "  ", "login", "sign in"]` and preferred `"sign in"` returns `["login"]`.
  - `test_update_adds_and_removes_variants_in_creation_order`: from `["a", "b"]`, PUT `["c", "a"]` returns `["a", "c"]`.
  - `test_update_can_change_the_language` (reading 10): PUT `{"language": "de"}`; the list for `en` is empty, the list for `de` has one term with the same preferred wording, variants and definition.
  - `test_case_sensitive_applies_to_every_wording`: after PUT `{"case_sensitive": true}` on a term with variant `"login"`, a check of `"Please LOGIN now"` reports nothing and `"Please login now"` reports one finding.
  - `test_term_changes_are_logged`: after POST, PUT and DELETE, `terminology_changes` (read through `client.app.state.db`) has three distinct batches, all with origin `manual` and the admin's user id.
  - `test_two_edits_in_a_row_both_succeed`: two PUTs on the same term, the second built without re-reading in the test: both 200 (the endpoint reads the current numbers itself).
  - `test_renaming_keeps_the_term_id`: the `id` returned by PUT equals the one from POST.
  - `test_renaming_to_a_current_variant_drops_that_variant`: variants `["login"]`, PUT `{"preferred": "login"}` returns 200 with `forbidden_variants == []`.
- [ ] **Step 3:** Run `tests/test_terminology.py tests/test_terminology_api.py`: the switched and the new tests FAIL.
- [ ] **Step 4:** Rewrite the checker's data access. Rewrite the four term endpoints; add `get_concept_by_section`; delete the old store methods and the `Term` export.
- [ ] **Step 5: Seeding.** `seed_terminology` creates each entry with `store.create_concept(domain.id, [SectionInput(…)], actor=Actor.system(Origin.SEED))`. Rewrite `tests/test_seed.py::test_seed_creates_domain_with_terms_for_all_languages` to assert through `list_sections` that every language has at least one section with a preferred and a forbidden term, and add `test_seed_is_logged_with_origin_seed_and_no_user`.
- [ ] **Step 6: Remaining callers of the old store methods.** In `tests/test_terminology.py`: delete `test_create_and_update_term`, `test_list_terms_filters_by_language`, `test_delete_term` and `test_terms_inherit_domain_ownership` (their rules are covered by Tasks 5 to 7 and by the API tests); rewrite `test_delete_domain_cascades_terms` with `add_term` to assert `list_concepts` returns `None` afterwards. In `tests/test_import_postgres.py`, replace the `create_term` call with `add_term`, set the expected `terms` count to 0 and delete the assertion on the `terms` row; Task 10 completes that file.
- [ ] **Step 7:** Run the gate on both backends. `tests/test_terminology_baseline.py`, `tests/test_check_api.py`, `tests/test_ownership.py` and `tests/test_demo_texts.py` must pass without having been edited. `rtk proxy grep -rnE "\.(create_term|update_term|delete_term|list_terms|get_term)\(" /Users/markus/IdeaProjects/fabulous-writing/backend/app` must print nothing (the endpoint functions keep their names).
- [ ] **Step 8:** Mutation checks: match forbidden terms with the preferred term's `case_sensitive`; drop the "equals preferred" cleaning. Each must fail a named test.
- [ ] **Step 9: Commit.** `feat(terminology): checker, term endpoints and seeding on the concept store`

---

### Task 10: Import tool and the restricted database role

**Files:**
- Modify: `backend/app/manage_import.py`
- Test: `backend/tests/test_import_postgres.py`, `backend/tests/test_postgres_privileges.py`

- [ ] **Step 1: Write the failing tests.**
  - `tests/test_import_postgres.py`: `_ALL_TABLES` becomes users, admin_audit, folders, documents, domains, terms, concepts, concept_domains, concept_languages, concept_terms, terminology_changes, profiles, profile_seed_markers, llm_usage. In the happy-path test the expected counts for the one `add_term(…, preferred="color")` are terms 0, concepts 1, concept_domains 1, concept_languages 1, concept_terms 1, terminology_changes 2. Add assertions that the imported term's `section_id` and the link's `domain_id` equal the source's, and that a concept created afterwards through a `TerminologyStore` on the target gets an id above the imported one.
  - `tests/test_postgres_privileges.py::test_api_smoke_under_restricted_role`: extend the term part to create, update and delete a term; afterwards read `SELECT COUNT(*)` from each of the five new tables over a connection opened with `restricted.restricted_dsn`; `terminology_changes` has at least three rows.
- [ ] **Step 2:** Run with `PG_ENV`: the import test FAILS (the new tables are not copied). The role test may already pass; it is a guard for the default privileges, say so in the report.
- [ ] **Step 3:** In `manage_import.py`, `_TABLES` gets the order above; `_IDENTITY_TABLES` excludes `profile_seed_markers` and `concept_domains`; update the comment above `_TABLES` (the declared foreign keys now include those of the concept tables).
- [ ] **Step 4:** Run the gate on both backends. **Commit.** `feat(terminology): import tool and role test cover the concept tables`

---

### Task 11: Migration of existing terms

**Files:**
- Create: `backend/app/services/terminology/migration.py`
- Modify: `backend/app/services/terminology/{schema,store}.py`, `backend/app/manage_import.py`
- Test: `backend/tests/test_terminology_migration.py` (create), `backend/tests/test_manage_schema.py`, `backend/tests/test_manage_init_db.py`, `backend/tests/test_import_postgres.py`

**Interfaces:**
- Consumes: the `rows` functions, `changes.diff`, `changes.write`, the baseline module (Task 1).
- Produces:
  - `migration.LEGACY_TERMS_DDL: str`: the old `CREATE TABLE terms (…)` statement, verbatim from today's schema but without `IF NOT EXISTS`, used by tests.
  - `migration.migrate_legacy_terms(conn, *, now: str) -> int` (number of concepts created).
  - `schema.verify(conn) -> None`: `verify_schema(conn, REQUIRED_SCHEMA)`, then a `RuntimeError` if a table `terms` exists: "legacy table 'terms' has not been migrated. Run the 'init-db' manage command with an admin FW_DATABASE_URL first."
- `SCHEMA` and `REQUIRED_SCHEMA` lose the `terms` table. `manage_import._TABLES` loses `terms`.
- Store constructor with `manage_schema=True`: `executescript(SCHEMA)`, `migrate_domains(conn)`, `conn.commit()`, then `migrate_legacy_terms(conn, now=_utcnow())`, all on the one connection. The commit keeps the tables and the domain backfill when the term migration fails: without it, SQLite would keep the added `owner_id` column but roll back its backfill, and a later start would skip the backfill and leave every domain global. With `manage_schema=False`: `schema.verify(conn)`.

**Behaviour (spec 6; readings 7 and 8):**
- `terms` and `terms_legacy` both present: `RuntimeError` naming both tables; nothing is written.
- No `terms` table: return 0.
- Rows are read with their domain (`JOIN domains`), in id order. Per row: a concept with the domain's owner, linked to the domain; one section with the row's language and definition; the preferred term (preferred, active) unless the wording is empty or whitespace only; one forbidden active term per variant after skipping empty or whitespace-only ones, repeats, and one that equals the preferred wording exactly; every term with the row's `case_sensitive`; `created_*` and `modified_*` null on concept, section and terms; every `revision` 1; one batch of `carried_over` entries with origin `migration`, no user, `at = now`.
- **The section takes the old row's id** (`new_section_ids`), so that `PUT` and `DELETE /api/terms/{id}` address the same entry before and after. On Postgres the migration then moves the identity past the highest id with `ALTER TABLE concept_languages ALTER COLUMN id RESTART WITH <max + 1>`, as `manage_import.py` does and for the same reason (it rolls back with the transaction); SQLite needs nothing.
- The rows are written with `rows.insert_concept`, `rows.set_links` and `rows.apply_sections` (`now=None`, `user_id=None`) and logged with `changes.diff(None, concept, initial_action=Action.CARRIED_OVER)` and `changes.write`, so that the migration cannot drift from what a save writes. The store's `_validate` is not used: carried-over data is taken as it is.
- Warnings through the module logger: one per variant equal to its preferred wording, naming the domain and the wording; one for a row left without any term; one with the number of rows whose domain is missing, if any.
- The last statement is `ALTER TABLE terms RENAME TO terms_legacy`. Every insert comes before it, so a failure rolls everything back on both backends.

- [ ] **Step 1: Write the failing tests.** A helper `legacy(db, rows)` creates `domains` (current shape) and `terms` (`LEGACY_TERMS_DDL`) through `conn.executescript` inside `db.connect()` (the identity column needs that path on Postgres) and inserts the given rows with SQL.
  - `test_rows_become_concepts_sections_and_terms` (both backends): a global and an owned domain; rows in en, de and ja; one row with variants `["login", "", "  ", "login", "log-in", "sign in"]` and preferred `"sign in"`. After `TerminologyStore(db)`: one concept per row with the right owner and domain; that row's section has `sign in` preferred and `login`, `log-in` forbidden, all active, all with the row's `case_sensitive`; `created_at` and `modified_at` are `None` and `revision` is 1 on every concept, section and term.
  - `test_sections_keep_the_old_term_ids` (both backends): legacy rows with ids 1, 3 and 4 become sections with ids 1, 3 and 4; a concept created afterwards gets a section id above 4.
  - `test_migration_logs_carried_over_entries`: per concept one batch, action `carried_over`, origin `migration`, `user_id is None`, one shared `at`; term entries carry `term_text` and `term_language`.
  - `test_variant_equal_to_preferred_is_skipped_with_a_warning` (`caplog`): the message contains the domain name and the wording.
  - `test_variant_differing_only_in_case_is_carried_over`.
  - `test_old_table_is_renamed_and_a_second_start_changes_nothing`: `table_columns(conn, "terms") == set()`, `terms_legacy` has the original rows; constructing the store again leaves the row counts of all five new tables unchanged.
  - `test_failed_migration_leaves_everything_as_it_was` (both backends): patch `changes.write` to raise on its third call; the constructor raises; afterwards `terms` still exists with its rows, `terms_legacy` does not, and `concepts` and `terminology_changes` are empty. Constructing the store again without the patch succeeds and migrates.
  - `test_failed_term_migration_keeps_the_domain_backfill` (SQLite only): a `domains` table from before ownership (no `owner_id` column) with one domain that is not the seed domain, plus a legacy `terms` table with one row; patch `changes.write` to raise; the constructor raises; a second construction without the patch succeeds and `list_domains(owner_id=1)` shows that domain with `is_global is False`.
  - `test_both_tables_present_stops_startup`: a `RuntimeError` whose message contains `'terms'` and `'terms_legacy'` in quotes; afterwards `terms` has its rows and `concepts` is empty.
  - `test_row_with_empty_preferred_keeps_its_forbidden_terms` and `test_row_without_any_usable_wording_is_skipped_with_a_warning` (reading 8).
  - `test_row_of_a_deleted_domain_is_not_migrated` (SQLite only; the orphan row is inserted over `db.raw_connect()`, which leaves foreign keys off): no concept, one warning with the count.
  - `test_check_results_after_migration_match_the_baseline` (both backends): `legacy()` with `BASELINE_DOMAINS` (honouring `is_global`; owned domains get owner 1), then for every domain and language `normalise([f.model_dump(mode="json") for f in TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models)).check(BASELINE_TEXTS[language], language, domain_id, owner_id=1)]) == load_golden()[key]`. The registry is the one the API uses, so Japanese and Chinese are matched by tokens as when the baseline was recorded; build it as `TestCjkChecker` does.
  - In `tests/test_manage_schema.py`: `test_unmigrated_terms_table_fails_verification` (create the schema, add a `terms` table with `LEGACY_TERMS_DDL`, construct `TerminologyStore(db, manage_schema=False)`: `RuntimeError` matching `init-db`) and `test_missing_concept_table_fails_verification` (drop `concept_terms`; the message names it).
  - In `tests/test_manage_init_db.py`: replace `"terms"` in the expected table set with the five new tables.
  - In `tests/test_import_postgres.py`: remove `terms` from `_ALL_TABLES` and from the expected counts; add `test_source_from_before_the_concept_model_is_migrated_and_imported`: a source file with `domains` and a legacy `terms` table holding two rows; `main(["--db", src, "import-to-postgres"])` returns 0; the target has two concepts and no table named `terms` or `terms_legacy`.
  - `tests/test_terminology.py::test_migration_backfills_domain_ownership` keeps passing unchanged.
- [ ] **Step 2:** Run: FAIL. **Step 3:** Implement.
- [ ] **Step 4:** Mutation checks: issue the rename before the inserts and commit right after it (the failed-migration test must fail; report on which backend); drop the "equals preferred" skip; drop the both-tables check; drop the identity restart (the id test must fail on Postgres); drop the `conn.commit()` before the term migration (the failed-migration test must fail on Postgres, where the tables vanish with the rollback, and the domain-backfill test on SQLite).
- [ ] **Step 5:** Run the gate on both backends. **Commit.** `feat(terminology): migrate existing terms to concepts`

---

### Task 12: Documentation

**Files:**
- Modify: `docs/backend-architecture.md`

- [ ] **Step 1:** Rewrite the "Terminology" section of `docs/backend-architecture.md` for the as-built state: the package and what each module owns; the five tables; the rules the store enforces and the lock order with its reason; the three version numbers, what increases each, and what a save compares; how a save produces log entries; the migration and `terms_legacy`; the translation in the endpoints and that it is temporary; the checker's data source and the new rule id. Keep the paragraphs on domain ownership and on the casing rules that still hold. Update the "Ownership" section for `visible_clause`, `is_visible`, `require_writable` and for concepts having their own `owner_id`. Update the module map and the testing section where they name `terminology.py` or its tests.
- [ ] **Step 2:** Read spec sections 5.7, 6 and 14 against the code as built and report any sentence that no longer matches; do not change the spec without the owner.
- [ ] **Step 3:** Run `rtk proxy grep -n "terms(id, domain_id" /Users/markus/IdeaProjects/fabulous-writing/docs/backend-architecture.md`: no match. **Commit.** `docs: terminology concept store`

---

## Review Focus

Inputs the spec implies and that no spec-listed test names. Each has its test in the task that owns the code.

1. **A legacy row with an empty preferred wording** must not stop the app from starting. Task 11, `test_row_with_empty_preferred_keeps_its_forbidden_terms`.
2. **A legacy row whose domain is gone** must not stop the migration. Task 11, `test_row_of_a_deleted_domain_is_not_migrated`.
3. **Two terms swapping their wording in one save** is a valid save. Task 6, `test_two_terms_can_swap_their_wording_in_one_save`.
4. **A non-admin saving a global concept without changes** still gets the refusal, not a silent success. Task 6, `test_non_admin_cannot_save_a_global_concept_even_without_changes`.
5. **Changing a term's language in the current screen** keeps working. Task 9, `test_update_can_change_the_language`.

## Execution Plan

Subagent-driven, one implementer at a time, never more than one agent running besides the controller. The controller (this session's model) dispatches, reads each report, and runs the gate itself on both backends before accepting a task. Models are the `model` values of the Agent tool. Every commit leaves the suite green.

| Task | Implementer | Why this model |
|---|---|---|
| 1 Baseline | sonnet | Data design needs care; no product code. |
| 2 Ownership | haiku | Three small functions and a mechanical replacement. |
| 3 Package, models, schema | sonnet | Wide but fully specified. |
| 4 Change log | sonnet | Pure function with a complete case table. |
| 5 Create, read, delete | sonnet | Sets the internal structure the next two tasks reuse. |
| 6 Save | opus | The rules interact: version check, no-change detection, locking, validation order. |
| 7 Domain links | sonnet | Builds on Task 6's structure. |
| 8 Simultaneous writes | opus | Process races and mutations that must fail reliably. |
| 9 Checker, endpoints, seeding | opus | Largest task; user-visible behaviour must stay the same. |
| 10 Import tool, role | sonnet | Postgres-only tests with identity and count reasoning. |
| 11 Migration | opus | Rewrites existing data; transaction behaviour differs per backend. |
| 12 Documentation | sonnet | Needs the whole as-built picture. |

| Review | After tasks | Reviewer | Scope |
|---|---|---|---|
| R1 | 1 to 3 | sonnet | Baseline data covers what Task 1 lists; models and schema match spec 5.2 and 7 column by column. |
| R2 | 4 and 5 | opus | The comparison rules against spec 7; lock-first order; visibility and admin checks; evidence that the mutation checks were run. |
| R3 | 6 to 8 | opus | Store rules of spec 5.3 and 5.4 one by one; version numbers of spec 5.7 (what increases, what is compared, unlisted sections untouched); saves without changes; the concurrency tests and their mutation evidence. |
| R4 | 9 and 10 | opus | Check results unchanged (baseline file untouched and green); the endpoint table; no remaining caller of the old methods; table lists. |
| R5 | 11 | opus | The migration alone: all or nothing on both backends, every skip rule, row and log expectations, the import of an old source. |
| Final | whole branch, after 12 | opus | Spec sections 5, 6, 7 and 9.1 requirement by requirement; documentation against the code; a directory sweep for inline ownership checks in the package and for any `UPDATE` or `DELETE` on `terminology_changes`. |

Each review gets the spec, this plan, the task reports and the diff of its range, and returns findings with severity, location and a concrete fix. Findings are fixed by a new implementer dispatch on the model of the task they belong to; the same reviewer then re-checks only those findings.

## Out of plan

- **Pull request, logbook:** after the final review the branch goes up as a pull request that refers to #205. The logbook entry is the last commit on the branch, on the owner's cue. Merge by rebase, to keep the commits.
- **Manual check by the owner** on a copy of a real database: start the app, confirm the terminology screen shows the same terms, run a check, edit a term.

## Plan review

Reviewed on 2026-11-22 by an Opus agent against the spec and the code as built (spec conformance, internal consistency, coherence with the code, executability). No critical finding; six important and ten minor ones, all applied, and confirmed in a scoped re-check that added three minor points, also applied: a commit between schema setup and the term migration; whitespace-only legacy variants; the baseline comparison with the tokenising checker; a partial-write test that can fail; the caller sweep that matched endpoint names; cleaning on rename; and the model assignments for Tasks 9 and 10 and review R4.

After that review the owner decided on version numbers on concept, language section and term, created and modified fields on the language section, modified fields that follow the level's own number, and a "Save all" that leaves unlisted sections alone (spec 5.7, 9.2, 10). Tasks 3 to 9 and 11 were changed accordingly, and the spec amendments that Task 12 was to make are now in the spec itself. The changed parts went through a further scoped review by the same agent.
