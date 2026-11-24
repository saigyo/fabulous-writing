# Terminology T1, Pull Request 3: Concept Endpoints and Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Writers manage terminology as concepts: seven concept endpoints replace the old term endpoints, a concept list and a concept entry replace the term table, and the legacy table is dropped.

**Architecture:** The store already has every operation; the API module becomes a thin layer over it and loses the translation layer. In the browser, everything that decides something (labels, search, unsaved changes, what a save sends, what a server answer replaces) lives in two modules of pure functions with their own tests; the components only render and call them. The concept entry keeps, per language section and for the domain links, the version it read and the writer's edits side by side.

**Tech Stack:** Python 3, FastAPI, Pydantic v2, SQLite and Postgres through the shared database seam, pytest. React 19, TypeScript, zustand, vitest with Testing Library, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-design.md`, sections 9.2 and 10, with 5.3 to 5.5 and 5.7 for the rules behind them, and the mockup `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-mockup.html`. Executors read all three.

## Global Constraints

- **Branch:** all work on `terminology-t1-pr3-concept-screen`, created from `main`. Never commit to `main`.
- **The checker does not change.** `backend/app/checkers/terminology.py` and `backend/tests/data/terminology_baseline.json` are not edited; `tests/test_terminology_baseline.py` stays green in every commit (Task 2 changes only how that test creates its data).
- **No change to the rules of the store.** `_validate`, `_check_versions`, `_check_domains`, locking and the change log stay as they are. If a task seems to need a change there, stop: the plan is wrong.
- **Nothing under `clients/` changes.** The browser extension and the embed do not call the term endpoints.
- **Commit trailer on every commit:** `Co-Authored-By: <model> <noreply@anthropic.com>`, naming the model that makes the commit.
- **Backend commands** run from `backend/` with `rtk proxy uv run …`; **frontend commands** from `frontend/` with `rtk proxy npm …`. The shell's working directory is reset between calls: put `cd /Users/markus/IdeaProjects/fabulous-writing/<dir> && …` in the same command.
- **Backend gate (Tasks 1, 2, 8):** `rtk proxy uv run pytest -q` green with zero warnings, once without and once with the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (local `supabase start` stack; the controller confirms it is up before Task 1).
- **Frontend gate (Tasks 3 to 7):** `rtk proxy npm test`, `rtk proxy npm run lint` and `rtk proxy npm run build` all green.
- **Mutation-verify every new behaviour test:** change the rule it pins, watch the test fail, restore by re-editing the file (never `git checkout <file>`, never a scripted text replacement). State in the task report which mutation was run and how the test failed.
- **User-facing text** is added to `frontend/src/i18n/messages.ts` and all seven catalogs (`en`, `de`, `es`, `fr`, `it`, `ja`, `zh`) in the same commit, in the informal register (`register.test.ts`). `i18n.test.ts` requires identical keys everywhere. Keys the old term table used and nothing else uses are removed.
- **Styling** uses the existing theme tokens and classes in `frontend/src/App.css`; no new colour literals. The mockup fixes structure and placement, not colours.
- **Status is never shown by colour alone.** Every status chip has a visible wording and an accessible name that contains the status (Reading 6).
- **IDE tools.** The project is open in IntelliJ IDEA and its MCP tools work on this checkout (load them with ToolSearch, pass `projectPath=/Users/markus/IdeaProjects/fabulous-writing`). Prefer `search_symbol`, `search_text` and `get_file_problems` where they fit. Do not use the IDE's terminal, run-configuration, debugger or database tools.
- **No comments that retell the code.** Prefer the simplest correct solution.
- **Suite runtime:** local baselines are about 20 s (backend, SQLite) and the current `npm test` time, which the controller records before Task 3. Report a task that adds more than 2 s to either.
- **Ports 5173 and 8000** belong to the owner's dev servers. Never start, stop or bind anything there. Never touch `backend/data/fabulous.db` or `backend/config.yaml`.

## Readings of the spec that this plan fixes

A reviewer checks the code against these, not against a different reading.

1. **Request bodies.** They reuse the store's `SectionInput` and `TermInput`.
   - `POST /api/domains/{id}/concepts`: `{sections: SectionInput[], comment?: string}`.
   - `PUT /api/concepts/{id}`: `{sections?: SectionInput[], domain_ids?: int[], revision?: int, comment?: string}`. `domain_ids` without `revision` is a 422.
   - `PUT /api/concepts/{id}/languages/{language}`: `{id?: int, revision?: int, definition?: string, terms: TermInput[], comment?: string}`; the language comes from the path.
   - Every response that returns a concept is the store's `Concept` model as it serialises today (ids, uids, version numbers and created/modified fields of all three levels, `domain_ids`, `is_global`; no `owner_id`).
2. **Status codes.** `POST` answers 201, the two `DELETE`s 204, the rest 200. 403 without the `custom_domains` feature on `POST` only (as creating a term today) and for a global row and a non-admin; 404 when the store returns `None` or `False`; 422 from request validation.
3. **Shape of a 409.** `detail` is an object: `{"code": <rule of the store's error>, "message": <its text>}`, and for an out-of-date save also `"part"`: the language code, or `"links"`. The codes are the store's rule names, unchanged: `conflict`, `duplicate_text`, `second_preferred`, `no_section`, `no_domain`, `unknown_domain`, `domain_owner_mismatch`, `duplicate_language`, `unknown_term`, `duplicate_term`. The domain endpoints keep their text `detail`.
4. **Dropping the legacy table.** The store's startup migration drops `terms_legacy` after the term migration if the table exists (checked with `table_columns`, as the migration does), in the managed-schema path only. A database that still has the old `terms` table is migrated first, as today, and loses the renamed table in the same start. Schema verification (`manage_schema=false`) neither requires nor rejects `terms_legacy`, so production keeps working until `init-db` has been run under the admin connection.
5. **Label and list.** `conceptLabel(concept, language, order)` follows spec 5.5: active preferred term; else first active admitted term; else the first other term; each "first" by `localeCompare` with `sensitivity: 'base'`, then by plain comparison; else the same in the first other language in `order` that the concept has, marked as a fallback. `order` is the language list the server sends, which is the order of the `Language` enum; a language missing from `order` (the list has not loaded yet) comes after the listed ones, in the order of `concept.sections`. The list is sorted by label. "Other wordings" are the section's terms except the one that gave the label, in the order preferred, admitted, deprecated, forbidden, then by text. The search matches, without regard to case, any term text of any language of the concept.
6. **Status chips.** A chip shows the wording; its accessible name and its `title` are "wording, status", with ", candidate" appended for a candidate. A candidate chip has a dashed outline. In the entry the two statuses are select fields with visible text.
7. **The entry's state.** For each language section the entry holds the version it read (`saved`, absent for a new language) and the writer's `draft`; for the domain links it holds the `domain_ids` and the concept's version number it read, and the edited list. A part is **unsaved** when draft and saved differ; the number shown per section counts changed fields (definition, each changed field of a term, each added term, each removed term).
8. **What a save sends.**
   - "Save <language>": `PUT …/languages/{language}` with that section's draft and the id and version number of its `saved` state (neither for a new language).
   - "Save all": one `PUT /api/concepts/{id}` with the unsaved sections only, and `domain_ids` with `revision` only if the links are unsaved. Nothing unsaved: the button is disabled.
   - A section the writer removed is sent with an empty `terms` list. "Remove language" marks the section in the draft; it is removed by the next save of that section or by "Save all", and can be undone by "Discard" until then.
   - A new concept has no id until its first save. Either button then sends one `POST` with every section that has terms; afterwards the entry continues as an existing concept. Links edited before that first save stay unsaved and go with the next "Save all".
   - **One save at a time.** While a save or a reload is in flight, every field and every control of the entry is disabled. The answer is applied to the state as it is then, not to a copy taken when the request was sent.
   - The reason field is sent as `comment` by whichever save comes next and is cleared when that save succeeds.
9. **What an answer replaces** (`applySaved`). After any successful save:
   - **Sections.** The server's state replaces, saved and draft: every section that was just sent, and every section that is not unsaved (including ones the writer does not have yet, and ones that have disappeared). An unsaved section that was not sent keeps its `saved` state and its draft, so that its later save is refused if someone else changed it.
   - **Links that were sent.** `savedDomainIds`, `savedRevision` and the edited list all take the server's values.
   - **Links that were not sent and are not unsaved.** The same.
   - **Links that were not sent and are unsaved.** The edited list is always kept. `savedDomainIds` and `savedRevision` take the server's values if the server's `domain_ids` equal the ones that were read (as sets); otherwise both stay, so that the later link save is refused.
   The third case exists because adding or removing a language raises the concept's version number: without it, a writer who saves a new language and then their pending link change would be refused by their own save. It also lets a link save pass after someone else added or removed a language. Spec 5.7 refuses that save; here it passes on purpose, and nothing is lost, because the link list is sent complete and the other writer's languages are not touched.
10. **A save refused as out of date** (`code: "conflict"`) keeps all edits and shows, next to the button used, which part was changed (the language name, or "the domains") with the action "Load current version". That action asks first, then fetches the concept and replaces that one part, saved and draft. Any other refused save keeps the edits and shows its message next to the button used: translated for `duplicate_text` and `second_preferred`, otherwise the generic "change failed" text with, in this order of preference, the `message` of an object `detail`, a text `detail`, or the error's own message. A failed "Load current version" (also a 404, when the concept has been deleted meanwhile) is shown the same way.
11. **Checks before sending.** A section with an empty term text, the same text twice, or two active preferred terms cannot be saved: its save button is disabled and the reason is shown in the section. "Save all" is disabled while any unsaved section has such a problem. On a new concept both buttons are disabled while any section has one, because the first save sends them all.
12. **Leaving.** With anything unsaved, these ask first: the way back to the list; every change of the active domain, also the one that follows adding a domain; every change of the app view, whoever asks for it (the header and the account menu both call the store's `setActiveView`, which is where the guard sits); and closing or reloading the tab (`beforeunload`). Signing out is not guarded.
13. **Removal actions.** "Remove from this domain" calls `DELETE /api/domains/{id}/concepts/{concept_id}` and is disabled while the concept is in no other domain, judged by the links as they were read, and while anything is unsaved. "Delete concept" asks first. Both return to the list. Neither exists for a new concept.
14. **Read-only.** A global concept shown to a non-admin has every field disabled and no save, discard, add, remove or delete control. "+ Concept" is shown only with the `custom_domains` feature and a writable domain, as the add row is today.
15. **"Also in domains"** lists the concept's other domains and offers the remaining domains with the same `is_global` value as the concept. Changing it edits the draft of the links; it is stored by "Save all".
16. **From the mockup.** Built: the way back as "← <domain> / <label>", the "✓ saved" marker on a section without unsaved changes, and the status legend under the list. Not built: collapsed language sections; every section is shown open.
17. **The entry's lifetime.** `ConceptEntry` builds its state from its `concept` prop once, when it mounts, and ignores later changes of that prop. `TerminologyView` keeps the same entry mounted when a new concept gets its id. A saved concept is put into the view's list only if its `domain_ids` contain the active domain.
18. **Deleting a domain** asks first. The question states how many concepts are in no other domain and will be deleted; the number comes from `GET /api/domains/{id}/concepts`, fetched when the delete button is used.

## File Structure

**Backend**

| File | Change |
|---|---|
| `backend/app/api/terminology.py` | Seven concept endpoints and their request models; term endpoints, term models and the translation layer removed. |
| `backend/app/services/terminology/store.py` | `get_concept_by_section` and `section_ids_by_preferred` removed. |
| `backend/app/services/terminology/migration.py` | `drop_legacy_terms(conn)`. Called from the store's constructor after `migrate_legacy_terms`. |
| `backend/app/manage_import.py`, `backend/app/manage.py` | Comments and table handling that mention `terms_legacy`, brought in line. |
| `backend/tests/test_concept_api.py` | New: the concept endpoints. |
| `backend/tests/test_terminology_api.py` | Term endpoint tests removed; domain tests stay. |
| `backend/tests/terminology_helpers.py` | `post_concept(...)`, the one way tests create a concept through the API. |
| `backend/tests/test_ownership.py`, `test_check_api.py`, `test_postgres_privileges.py`, `test_terminology_baseline.py`, `test_terminology.py`, `test_terminology_migration.py`, `test_manage_init_db.py`, `test_import_postgres.py` | Moved off the term endpoints and the two removed store methods; legacy-table assertions updated. |

**Frontend**

| File | Change |
|---|---|
| `frontend/src/types.ts` | Concept types in; `Term` out. |
| `frontend/src/api/client.ts` | Seven concept functions in, four term functions out; `HttpError` carries `part` and `detailMessage`. |
| `frontend/src/terminology/labels.ts` (+ test) | New: label, other wordings, search, sorting, languages of a concept. |
| `frontend/src/terminology/conceptDraft.ts` (+ test) | New: the entry's state and every decision about it (Readings 7 to 11). |
| `frontend/src/terminology/StatusChip.tsx` | New. |
| `frontend/src/terminology/ConceptList.tsx` (+ test) | New. |
| `frontend/src/terminology/ConceptEntry.tsx`, `LanguageSectionEditor.tsx` (+ tests) | New. |
| `frontend/src/terminology/TerminologyView.tsx` (+ its two tests) | Domain sidebar stays; shows list or entry; domain delete asks. |
| `frontend/src/terminology/termTable.ts`, `termTable.test.ts` | Deleted. |
| `frontend/src/state/store.ts`, `frontend/src/App.tsx` | `terminologyUnsaved`, `pendingView` and the guarded view switch. |
| `frontend/src/i18n/messages.ts` and the seven catalogs | New keys in, unused keys out. |
| `frontend/src/App.css` | Styles for list, chips and entry. |

**Documentation:** `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `docs/fly-deployment.md`, `docs/architecture-atlas/atlas-data.js`, `README.md`, this plan, and `docs/LOGBOOK.md` (last commit, on the owner's cue).

---

### Task 1: Concept endpoints

**Files:**
- Modify: `backend/app/api/terminology.py`
- Modify: `backend/tests/terminology_helpers.py`
- Create: `backend/tests/test_concept_api.py`

**Interfaces:**
- Consumes: `TerminologyStore.list_concepts`, `get_concept`, `create_concept`, `save_concept`, `save_section`, `delete_concept`, `remove_concept_from_domain`; `SectionInput`, `TermInput`, `TerminologyRuleError.rule`, `TerminologyConflictError.part`.
- Produces: the seven endpoints of spec 9.2 with the bodies of Reading 1; and for tests

```python
def post_concept(
    client, domain_id: int, *, language: str = "en", preferred: str | None = None,
    forbidden: Sequence[str] = (), definition: str = "", case_sensitive: bool = False,
    headers: dict | None = None,
) -> Response
```

  which posts one section with an active preferred term (if given) and active forbidden terms, all with `case_sensitive`.

The old term endpoints stay untouched in this task.

- [ ] **Step 1: Write the failing tests** in `test_concept_api.py`, using the `client` fixtures and login helpers of `test_terminology_api.py`. One test per line:

| Test | Asserts |
|---|---|
| `test_create_list_get_roundtrip` | 201; body has `id`, `uid`, `revision == 1`, `domain_ids == [domain]`, `is_global`, no `owner_id`; each section and term has `id` and `revision == 1`; `GET` list and `GET` one return the same concept. |
| `test_create_needs_the_custom_domains_feature` | 403 for a user without it, with the same setup the term test uses today. |
| `test_save_and_delete_stay_allowed_without_the_feature` | With the setup of `test_term_update_delete_stay_allowed`: both `PUT`s and both `DELETE`s succeed for a user who has lost the feature. |
| `test_save_language_adds_changes_and_removes_terms` | `PUT …/languages/en` with one term changed, one without id, one left out: 200; the section's `revision` is 2, the concept's stays 1; the changed term's `revision` is 2. |
| `test_save_language_creates_a_new_section` | No `id`/`revision` for `de`: 200, the concept has two sections and `revision == 2`. |
| `test_save_language_without_terms_removes_the_section` | 200, one section left; for the last section 409 with `code == "no_section"`. |
| `test_save_concept_writes_only_listed_sections` | `PUT /api/concepts/{id}` listing `de` only: the `en` section's `revision` and `modified_at` are unchanged. |
| `test_save_concept_sets_domain_links` | With `domain_ids` and `revision`: 200 and both ids; with `domain_ids` and no `revision`: 422; with `[]`: 409 `no_domain`. |
| `test_out_of_date_language_names_the_language` | Second save with the old `revision`: 409, `detail == {"code": "conflict", "part": "en", "message": …}`; a following `GET` shows nothing was written. |
| `test_out_of_date_links_name_the_links` | 409 with `part == "links"` after a language was added in between. |
| `test_rule_violations_are_409_with_their_code` | Parametrised: `duplicate_text`, `second_preferred`, `domain_owner_mismatch` (an own concept linked to a global domain). |
| `test_invalid_values_are_422` | Parametrised: empty term text, unknown `usage_status`, unknown language in the path. |
| `test_remove_from_domain_and_delete` | Remove from one of two domains: 204, the concept stays; remove from the last: 409 `no_domain`; `DELETE /api/concepts/{id}`: 204, then 404. |
| `test_other_user_sees_404_everywhere` | All seven endpoints for another user's concept: 404. |
| `test_global_concept_is_read_only_for_non_admin` | `GET`s 200 for a non-admin; the five writing endpoints (`POST` on the global domain, both `PUT`s, both `DELETE`s) 403; an admin's save 200. |
| `test_comment_reaches_the_change_log` | After a save with `comment`, the row in `terminology_changes` (read through the store's database) has it. |

- [ ] **Step 2: Run them.** `rtk proxy uv run pytest -q tests/test_concept_api.py`. Expected: every test fails with 404 or 405.

- [ ] **Step 3: Implement** the request models `ConceptCreate`, `ConceptSave` (with a model validator for `domain_ids` without `revision`) and `SectionSave`, and the seven handlers. `_store_errors` turns a `TerminologyRuleError` into the 409 of Reading 3 for the concept endpoints. The handlers contain no rule of their own: they build the store call and map `None`/`False` to 404.

- [ ] **Step 4: Gate** on both backends. The old API tests still pass unchanged.

- [ ] **Step 5: Mutation checks**, at least: drop `part` from the 409; drop the feature check on `POST`; add a feature check to `PUT`; make the 422 for `domain_ids` without `revision` pass through; return 200 instead of 404 for an invisible concept.

- [ ] **Step 6: Commit** `feat(terminology): concept endpoints`.

### Task 2: Remove the term endpoints and the legacy table

**Files:** `backend/app/api/terminology.py`, `backend/app/services/terminology/store.py`, `migration.py`, `backend/app/manage_import.py`, `backend/app/manage.py`, and in `backend/tests/`: `test_concept_api.py`, `test_terminology_api.py`, `test_ownership.py`, `test_check_api.py`, `test_postgres_privileges.py`, `test_terminology_baseline.py`, `test_terminology.py`, `test_terminology_migration.py`, `test_manage_init_db.py`, `test_import_postgres.py`.

**Interfaces:**
- Consumes: `post_concept` from Task 1.
- Produces: `migration.drop_legacy_terms(conn) -> None`; a backend without `/api/terms`, `/api/domains/{id}/terms`, `TermCreate`, `TermUpdate`, `Term`, `get_concept_by_section`, `section_ids_by_preferred`.

- [ ] **Step 1: Move the tests first, while the old endpoints still exist.** Every test that creates data through a term endpoint uses `post_concept` instead; the ownership matrix in `test_ownership.py` lists the seven concept endpoints in place of the four term endpoints, with the same expectations per role. `test_terminology_baseline.py` creates the same data through `post_concept` (every term active, preferred or forbidden, the row's `case_sensitive` on each term). Run the gate: green, and `git diff --stat` shows `tests/data/terminology_baseline.json` untouched.

- [ ] **Step 2: Write the failing tests.**
  - `test_terminology_migration.py::test_legacy_table_is_dropped_after_migration`: a database with old `terms` rows; after constructing the store neither `terms` nor `terms_legacy` exists and the concepts are there.
  - `…::test_leftover_legacy_table_is_dropped_on_the_next_start`: a database in the state the previous release leaves (new tables plus `terms_legacy`); constructing the store drops the table and changes no concept and no change-log row.
  - `…::test_verification_accepts_a_leftover_legacy_table`: the same state with `manage_schema=False` constructs without error and leaves the table.
  - `test_concept_api.py::test_term_endpoints_are_gone`: the four old paths answer 404 or 405.
  Existing tests that assert `terms_legacy` exists after migration are changed to assert the new behaviour; the test for "both tables exist stops the start" stays.

- [ ] **Step 3: Run them.** Expected: three fail. `test_verification_accepts_a_leftover_legacy_table` passes already; it is a guard, and Step 6 shows that it can fail.

- [ ] **Step 4: Implement.** Delete the term endpoints, their models and every helper only they use; delete the two store methods and `test_terminology.py::test_section_order_follows_the_database_collation`, which tests one of them; add `drop_legacy_terms` and call it after `migrate_legacy_terms`; bring the import tool and `manage.py` in line (the import tool does not copy `terms_legacy` today; check that initialising the stores on its source file and dropping the table there is acceptable, which it is because the source is migrated in place already, and say so in the task report). Remove what is left unused (`search_symbol` for each removed name).

- [ ] **Step 5: Gate** on both backends.

- [ ] **Step 6: Mutation checks:** remove the call to `drop_legacy_terms`; make verification reject a leftover table.

- [ ] **Step 7: Commit** `feat(terminology)!: remove the term endpoints and drop terms_legacy`.

### Task 3: Types, client and list logic

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`
- Create: `frontend/src/terminology/labels.ts`, `frontend/src/terminology/labels.test.ts`

**Interfaces:**
- Produces, in `types.ts`: `UsageStatus`, `ProcessStatus`, `PartOfSpeech` (string unions with the backend's values), `ConceptTerm`, `LanguageSection`, `Concept`, `TermInput`, `SectionInput`, field for field as the backend models.
- Produces, in `client.ts`:

```ts
getConcepts(domainId: number): Promise<Concept[]>
getConcept(id: number): Promise<Concept>
createConcept(domainId: number, body: { sections: SectionInput[]; comment?: string }): Promise<Concept>
saveConcept(id: number, body: { sections?: SectionInput[]; domain_ids?: number[]; revision?: number; comment?: string }): Promise<Concept>
saveConceptLanguage(id: number, language: Language, body: Omit<SectionInput, 'language'> & { comment?: string }): Promise<Concept>
deleteConcept(id: number): Promise<void>
removeConceptFromDomain(domainId: number, conceptId: number): Promise<void>
```

  and on `HttpError`: `readonly part?: string`, `readonly detailMessage?: string`, filled from `detail.part` and `detail.message`.
- Produces, in `labels.ts`:

```ts
interface ConceptLabel { text: string; language: Language; fallback: boolean }
conceptLabel(concept: Concept, language: Language, order: Language[]): ConceptLabel
otherWordings(concept: Concept, language: Language): ConceptTerm[]
conceptLanguages(concept: Concept, order: Language[]): Language[]
matchesQuery(concept: Concept, query: string): boolean
sortByLabel(concepts: Concept[], language: Language, order: Language[]): Concept[]
```

The old `Term` type and the four term functions stay until Task 5 removes their last user.

- [ ] **Step 1: Write the failing tests** in `labels.test.ts`: one test per step of spec 5.5 (active preferred; candidate preferred is skipped in favour of an active admitted term; first admitted alphabetically; only forbidden terms; fallback to the first other language in `order` with `fallback: true`); `otherWordings` leaves out exactly the label's term and orders by status then text, and is empty for a fallback label; `matchesQuery` finds a wording of another language, ignores case, and accepts a blank query; `sortByLabel` does not mutate its input. In `client` tests (the file that already tests `HttpError`): a 409 whose `detail` is `{code, part, message}` gives an error with all three.

- [ ] **Step 2: Run** `rtk proxy npm test -- labels client`; expected: fail, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Frontend gate.**
- [ ] **Step 5: Mutation checks:** let a candidate count as active in `conceptLabel`; drop the fallback marker; make the search case-sensitive.
- [ ] **Step 6: Commit** `feat(terminology): concept types, client functions and list logic`.

### Task 4: The entry's state

**Files:**
- Create: `frontend/src/terminology/conceptDraft.ts`, `frontend/src/terminology/conceptDraft.test.ts`

**Interfaces:**
- Consumes: the types of Task 3.
- Produces:

```ts
interface TermDraft extends TermInput { key: string }          // key: stable React key, "t<id>" or "n<counter>"
interface SectionState {
  language: Language
  saved: LanguageSection | null                                  // null: not on the server yet
  definition: string
  terms: TermDraft[]
  removed: boolean
}
interface EntryState {
  conceptId: number | null                                       // null: new concept
  isGlobal: boolean
  sections: SectionState[]
  savedDomainIds: number[]
  savedRevision: number | null
  domainIds: number[]
}
type SectionProblem = 'empty_text' | 'duplicate_text' | 'second_preferred' | 'no_terms'

newEntry(domainId: number, isGlobal: boolean, language: Language): EntryState
entryFromConcept(concept: Concept): EntryState
addLanguage(state: EntryState, language: Language): EntryState
sectionChanges(section: SectionState): number
linksUnsaved(state: EntryState): boolean
unsavedLanguages(state: EntryState): Language[]
hasUnsaved(state: EntryState): boolean
sectionProblems(section: SectionState): SectionProblem[]
toSectionInput(section: SectionState): SectionInput
saveAllBody(state: EntryState, comment: string): { sections: SectionInput[]; domain_ids?: number[]; revision?: number; comment?: string }
discardSection(state: EntryState, language: Language): EntryState
discardAll(state: EntryState): EntryState
applySaved(state: EntryState, concept: Concept, sent: { languages: Language[]; links: boolean }): EntryState
reloadPart(state: EntryState, concept: Concept, part: Language | 'links'): EntryState
```

  All functions are pure and return new objects. `newEntry` has one section in `language` with one empty term, `preferred` and `active`; `addLanguage` adds a section of the same shape. `no_terms` is the problem of a section that is not marked removed and has no term. Discarding a section that has no `saved` state removes it from the entry; discarding a removed section restores it.

- [ ] **Step 1: Write the failing tests.** One test per sentence of Readings 7 to 9 and 11, with these in particular:
  - `sectionChanges`: 0 for an untouched section; 2 for two changed fields of one term; 1 for an added term; 1 for a removed term; definition counts 1; a field changed and changed back counts 0.
  - `toSectionInput`: a section with `saved` carries its id and version number; a new language carries neither; a removed section has `terms: []`; no `key` field is sent.
  - `saveAllBody`: contains only unsaved sections; contains `domain_ids` and `revision` only when the links are unsaved; link order does not make the links unsaved; an empty comment is left out.
  - `applySaved`, each as its own test: a sent section takes the server's state and becomes saved; an untouched section takes a change someone else made; **an unsaved section that was not sent keeps its `saved` version number and its draft**; a language someone else added appears; a language someone else removed disappears when untouched and stays when unsaved; **after a save that sent the links, they are saved and `savedRevision` is the server's**; with unsaved links that were not sent and unchanged server links, the version number is taken over and the edited list is kept; **with unsaved links that were not sent and different server links, `savedRevision` and `savedDomainIds` stay** and the edited list is kept; with links that are not unsaved, everything is taken over; for a new concept `conceptId` is set and edited links stay unsaved.
  - `discardAll` after `applySaved` for one language: that language keeps what was saved, the others return to what was read (spec 10: what a language save has stored stays stored).
  - `reloadPart`: replaces exactly the named part and leaves an unsaved other section as it is.
  - `sectionProblems`: each of the four; a candidate preferred term next to an active one is no problem.

- [ ] **Step 2: Run** `rtk proxy npm test -- conceptDraft`; expected: fail, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Frontend gate.**
- [ ] **Step 5: Mutation checks**, at least the three bold cases: let `applySaved` replace every section; let it always take over the concept's version number; let it ignore `sent.links`. Also: let `saveAllBody` send every section.
- [ ] **Step 6: Commit** `feat(terminology): state of the concept entry`.

### Task 5: Concept list

**Files:**
- Create: `frontend/src/terminology/StatusChip.tsx`, `ConceptList.tsx`, `ConceptList.test.tsx`
- Modify: `frontend/src/terminology/TerminologyView.tsx` and its two test files, `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`, `frontend/src/types.ts`, `frontend/src/api/client.ts`
- Delete: `frontend/src/terminology/termTable.ts`, `termTable.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```tsx
<StatusChip term={ConceptTerm} />
<ConceptList
  domain={Domain} concepts={Concept[]} domains={Domain[]}
  readOnly={boolean} canCreate={boolean}
  onOpen={(conceptId: number) => void} onCreate={(language: Language) => void} />
```

  `TerminologyView` owns `concepts` (loaded with `getConcepts`, with the same two guards the term fetch has today: latest request wins, and results for a domain the writer left are dropped) and `open: { conceptId: number | null; language: Language } | null` (`conceptId: null` is a new concept; `language` is the list's chosen language). In this task opening a row or "+ Concept" only sets `open`; the view then renders a placeholder that Task 6 replaces.

- [ ] **Step 1: Write the failing tests** (`ConceptList.test.tsx`, fetch mocked as in the existing view tests):
  - the label column shows the preferred term of the chosen language; a concept without a term in it shows the fallback with its language marker and the "no term in <language>" text;
  - other wordings are chips whose accessible name contains the status, and a candidate's contains "candidate";
  - the languages column and the "also in" column (names of the concept's other domains; a dash when none); the legend under the list names the four statuses and the candidate;
  - the language selector starts on the interface language and changes labels;
  - the search filters by a wording of another language; "no concepts match" appears when the filter empties a non-empty list;
  - "+ Concept" is absent without the feature and for a read-only domain.
  In the two `TerminologyView` test files: the tests about the term table (add row, row edit, per-term buttons, stale edit row) are replaced by their concept equivalents where one exists (create affordance, read-only domain, the two fetch-ordering tests against `/api/domains/{id}/concepts`); the domain tests stay. A new test: deleting a domain opens a question that names the number of concepts that are in no other domain, and deletes only after confirming.

- [ ] **Step 2: Run them**; expected: fail.
- [ ] **Step 3: Implement.** The domain delete uses `ConfirmDialog`. Remove `Term`, the four term functions, `termTable.ts` and the message keys only they used.
- [ ] **Step 4: Frontend gate.**
- [ ] **Step 5: Mutation checks:** drop the accessible name of the chip; delete the domain without waiting for the confirmation; drop one of the two fetch guards.
- [ ] **Step 6: Commit** `feat(terminology): concept list replaces the term table`.

### Task 6: Concept entry

**Files:**
- Create: `frontend/src/terminology/ConceptEntry.tsx`, `LanguageSectionEditor.tsx`, `ConceptEntry.test.tsx`
- Modify: `TerminologyView.tsx`, `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`

**Interfaces:**
- Consumes: Tasks 3 to 5.
- Produces:

```tsx
<ConceptEntry
  domain={Domain} domains={Domain[]} concept={Concept | null} newLanguage={Language}
  readOnly={boolean}
  onBack={() => void}                 // list is shown again
  onSaved={(concept: Concept) => void}   // parent updates its list
  onGone={() => void}                 // deleted or removed from this domain
  onUnsavedChange={(unsaved: boolean) => void} />
<LanguageSectionEditor
  section={SectionState} readOnly={boolean} saving={boolean}
  error={string | null} conflict={boolean}
  onChange={(section: SectionState) => void}
  onSave={() => void} onDiscard={() => void} onRemove={() => void} onReload={() => void} />
```

  `ConceptEntry` holds one `EntryState`, built once (Reading 17), and never decides anything `conceptDraft.ts` decides. `onUnsavedChange` is wired but only used by Task 7; so is `conflict`/`onReload`, which this task renders (Reading 10) and Task 7 completes with the reload itself.

This task builds: the header with the way back, "Also in domains" (Reading 15), "Remove from this domain" and "Delete concept" (Reading 13); one editor per language with definition, term rows (text, usage status, process status, reason), details per term (context, source, part of speech, match case), "+ Term", remove term, "Remove language", the hint that a term is entered in its base form (spec 5.6); "+ Language" offering the languages the concept does not have; per-section "Save <language>" and "Discard" with the count of unsaved changes; the footer with the reason field, the list of unsaved languages, "Discard all" and "Save all"; the checks of Reading 11; read-only mode (Reading 14); errors next to the button used.

- [ ] **Step 1: Write the failing tests** (`ConceptEntry.test.tsx`, fetch mocked; each asserts the request that was sent and what the screen shows afterwards):
  - saving one language sends one `PUT …/languages/de` with that section's id and version number and nothing of the other section; an edit in the other section is still on screen and still marked unsaved afterwards;
  - "Save all" with two edited sections and untouched links sends one `PUT /api/concepts/{id}` whose body has exactly those two sections and no `domain_ids`; with an edited link it has `domain_ids` and `revision`;
  - both save buttons are disabled without unsaved changes; the section's button is disabled and the reason shown for each problem of Reading 11;
  - a new concept: the first "Save <language>" sends one `POST /api/domains/{id}/concepts` with every section that has terms; a second save sends a `PUT`; with a second language that still has an empty term, both save buttons are disabled;
  - a new concept saved while `TerminologyView` renders it: after the save the entry is the same one, a second language edited meanwhile is still shown and still unsaved;
  - while a save is pending, no field and no button of the entry is enabled, and "Save all" used right after "Save <language>" cannot send a second request;
  - after "Save all" with an edited link, the links are no longer unsaved and a second "Save all" with a new link sends the server's new `revision`;
  - "Discard" is disabled for a section without unsaved changes; "Also in domains" offers only domains with the concept's `is_global` value;
  - a new language section is sent without id and version number; "Remove language" followed by its save sends `terms: []`, and "Discard" before saving restores it;
  - the reason is sent as `comment` once and the field is empty after a successful save, and still filled after a failed one;
  - a failed save (500) keeps every edit and shows the error next to the button used, not at the other one;
  - a 409 with `code: "second_preferred"` shows the translated text;
  - "Remove from this domain" is disabled when the concept has one domain and while anything is unsaved; with two it sends the `DELETE` and calls `onGone`; "Delete concept" asks first;
  - a read-only entry has no enabled field and none of the controls of Reading 14;
  - the details of a term open and close, and an edit there marks the section unsaved.

- [ ] **Step 2: Run them**; expected: fail.
- [ ] **Step 3: Implement.** `TerminologyView` renders the entry instead of the list while `open` is set, updates its `concepts` from `onSaved` (Reading 17), and reloads them on `onGone`.
- [ ] **Step 4: Frontend gate.**
- [ ] **Step 5: Mutation checks:** send every section from "Save <language>"; clear the reason on a failed save; enable saving with a section problem; show the error at both buttons; leave the controls enabled while a save is pending; rebuild the entry's state when its `concept` prop changes.
- [ ] **Step 6: Commit** `feat(terminology): concept entry`.

### Task 7: Out-of-date saves and leaving with unsaved changes

**Files:**
- Modify: `ConceptEntry.tsx`, `LanguageSectionEditor.tsx`, `ConceptEntry.test.tsx`, `TerminologyView.tsx`, `frontend/src/state/store.ts`, `frontend/src/App.tsx`, the message files
- Test: `ConceptEntry.test.tsx`, `TerminologyView.ownership.test.tsx`, and the App test file that covers the view switch

**Interfaces:**
- Consumes: `HttpError.code`/`part`, `reloadPart`, `hasUnsaved`.
- Produces, in the store: `terminologyUnsaved: boolean`, `setTerminologyUnsaved(value: boolean)`, `pendingView: ActiveView | null`, `confirmPendingView()`, `cancelPendingView()`. `setActiveView` to another view while `terminologyUnsaved` is set stores the wish in `pendingView` and changes nothing else; `App.tsx` shows a `ConfirmDialog` while `pendingView` is set. `TerminologyView` sets the flag from `onUnsavedChange` and resets it on unmount.

- [ ] **Step 1: Write the failing tests.**
  - A language save answered with 409 `{code: "conflict", part: "de"}`: the edits stay, the German section says that someone else changed this language and offers "Load current version"; using it asks first; after confirming, `GET /api/concepts/{id}` is called, the German section shows the server's state and is not unsaved, and an unsaved edit in the English section is untouched; cancelling the question changes nothing.
  - "Save all" answered with `part: "links"`: the message at "Save all" names the domains; loading replaces the links only.
  - "Save all" answered with `part: "en"` while German was also sent: nothing is marked saved; the message names English.
  - After a conflict, a successful save of the same part clears the message.
  - With unsaved changes: the way back, a click on another domain, adding a domain, a click on another view in the header, and the account menu's "Activity" item each open a question and act only after confirming; without unsaved changes they act at once. A `beforeunload` event is prevented only while something is unsaved.
  - The flag is false again after saving, after discarding, after leaving the entry and after the view unmounts.

- [ ] **Step 2: Run them**; expected: fail.
- [ ] **Step 3: Implement.** The other views and the callers of `setActiveView` are not changed.
- [ ] **Step 4: Frontend gate.**
- [ ] **Step 5: Mutation checks:** let the reload replace the whole entry; skip the question before the reload; leave the flag set after a save; remove the `beforeunload` condition.
- [ ] **Step 6: Commit** `feat(terminology): refused saves and leaving with unsaved changes`.

### Task 8: Documentation

**Files:** `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `docs/fly-deployment.md`, `README.md`

- [ ] **Step 1:** Backend architecture: the API section (seven endpoints, the 409 shape, where the translation layer was), the store section (two methods gone), the migration section (legacy table dropped, verification unchanged), the testing list.
- [ ] **Step 2:** Frontend architecture: the `terminology/` entry of the file tree and the paragraphs that describe `TerminologyView.tsx` today, rewritten for list, entry and the two logic modules; the unsaved-changes flag and the guarded view switch; what is deliberately not guarded (signing out).
- [ ] **Step 3:** Deployment: upgrade note for this release. `init-db` under the admin connection drops `terms_legacy`; it can run before or after the deploy and needs no stop, because neither the previous nor the new release reads that table; until it has run, the table stays and nothing else differs. State that the original rows are gone afterwards, and that the import tool, which initialises the stores on its source file, now removes the table from that file too.
- [ ] **Step 4:** README: the two places that name `/api/terms`. Architecture atlas (`docs/architecture-atlas/atlas-data.js`): the entries that name `termTable.ts` and `/api/terms`.
- [ ] **Step 5:** Check every statement against the code (`search_text` for each endpoint path and each function named). Both gates green.
- [ ] **Step 6: Commit** `docs: concept endpoints and concept screen`.

---

## Review Focus

Conditions the spec implies and a writer will meet. Each has its test in the task named.

1. **A save of one language must not carry stale state of another.** After saving German, an unsaved English section must still be refused if someone else changed English. Task 4 (`applySaved`, bold case 1), Task 6 (first test).
2. **A writer's own language save must not block their pending link change.** Task 4 (`applySaved`, link cases).
3. **A refused or failed save must not lose text.** Tasks 6 and 7: edits and the reason field survive 409 and 500.
4. **An answer for a domain or concept the writer has left must not appear.** Task 5 (the two fetch guards); Task 6: `onSaved` for a concept that is no longer open updates the list only.
5. **A non-admin must not be offered a write on a global concept, and the server must refuse it anyway.** Task 1 (`test_global_concept_is_read_only_for_non_admin`), Task 6 (read-only test).
6. **A leftover `terms_legacy` must not stop a start, in either schema mode.** Task 2.

## Execution Plan

Subagent-driven, one implementer at a time. The controller (this session's model) dispatches, reads each report, and runs the gates itself before accepting a task. Models are the `model` values of the Agent tool.

| Task | Implementer | Why this model |
|---|---|---|
| 1 Concept endpoints | sonnet | Thin handlers over an existing store; the tests are listed. |
| 2 Removal and legacy table | sonnet | Mostly moving tests; the one new behaviour is three lines with three tests. |
| 3 Types, client, list logic | sonnet | Mirrors backend models; small pure functions. |
| 4 Entry state | opus | The rules for what a server answer may replace are where lost edits would come from. |
| 5 Concept list | sonnet | One component and the rework of existing view tests. |
| 6 Concept entry | opus | The largest component; many controls must stay consistent with one state. |
| 7 Refused saves and leaving | opus | Touches the app shell and the store; conflict paths are easy to get subtly wrong. |
| 8 Documentation | sonnet | Needs the as-built picture. |

| Review | After tasks | Reviewer | Scope |
|---|---|---|---|
| R1 | 1 and 2 | opus | Spec 9.2 line by line; Readings 1 to 4; ownership on all seven endpoints; nothing left of the translation layer; the baseline file untouched; the legacy drop in both schema modes; evidence of the mutation checks. |
| R2 | 3 and 4 | opus | Readings 5 and 7 to 9 and 11 against `labels.ts` and `conceptDraft.ts`; whether each test would fail for the bug it names; purity of the functions. |
| R3 | 5 to 7 | opus | Spec section 10 line by line against the screen; Readings 6 and 10 to 18; that the components decide nothing the logic modules decide; the seven catalogs (register, no English left in another catalog); accessibility of chips, selects and dialogs. |
| Final | whole branch, after 8 | sonnet | Documentation against the code; nothing outside File Structure changed; no leftover reference to the term endpoints, `Term`, `termTable` or `terms_legacy` outside the migration and its tests. |

Each review gets the spec, the mockup, this plan, the task reports and the diff of its range, and returns findings with severity, location and a concrete fix. Findings are fixed by the implementer of the task they belong to; the same reviewer then re-checks only those findings.

**Trial in the browser,** by the controller after R3 and before the final review, on its own scratch stack (own `config.yaml` with a scratch SQLite file, ports other than 5173 and 8000): a database created by release 0.7.6 with terms in two domains is upgraded by the branch build; then, through the screen: the list and its fallback label, a new concept with two languages, saving one language while the other is edited, "Save all", a link to a second domain, a conflict provoked from a second browser context and resolved with "Load current version", the two removal actions, the domain delete question, a non-admin on the built-in domain, and one check in the editor that reports a deprecated term as a warning.

## Out of plan

- A history view, import and export, per-domain overrides, merging of conflicting edits, paging (spec section 2).
- A guard for signing out with unsaved changes.
- Sortable columns in the concept list; the list is sorted by label.
- Collapsed language sections in the entry.
- The order of findings on the CJK token path (left open in the second pull request).

## Plan review

Reviewed by an Opus agent against the spec, the mockup and the code before execution. Its findings are worked in: `applySaved` is told whether the links were sent (without that, every link save would have left the links unsaved with an old version number); the edited link list is never overwritten while unsaved; one save at a time; the guards cover every view change, adding a domain and "Remove from this domain"; the entry builds its state once; the first save of a new concept waits for every section; a test that saving and deleting need no feature; the file lists of Task 2 and Task 8; the mockup elements that are and are not built.
