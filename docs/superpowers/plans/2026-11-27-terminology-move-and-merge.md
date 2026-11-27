# Terminology: Moving Terms and Merging Concepts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A writer can merge a concept into another one, move one term to another concept, and split a term off into a new concept, each after a preview that shows exactly what will happen.

**Architecture:** One store function, `_transfer`, moves a set of terms from a source concept to a target and is the only place the rules live. Two store methods call it (merge: all terms; move: one term), and each can run as a preview: the same code in the same transaction, which is then rolled back. Two endpoints expose them. In the browser, a module of pure functions turns the server's answer into what the dialogs show; two dialogs render it; the concept entry opens them.

**Tech Stack:** Python 3, FastAPI, Pydantic v2, SQLite and Postgres through the shared database seam, pytest. React 19, TypeScript, zustand, vitest with Testing Library, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-27-terminology-move-and-merge-design.md` ("the spec") with its mockup `docs/superpowers/specs/2026-11-27-terminology-move-and-merge-mockup.html` ("the mockup"). It builds on `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-design.md` ("the concept spec"), sections 5.3, 5.4, 5.7 and 7. Executors read the spec and, for Tasks 6 to 9, open the mockup.

## Global Constraints

- **Branch:** all work on `terminology-move-merge`, which already holds the spec and this plan. Never commit to `main`.
- **Existing rules do not change.** `_validate`, `_check_versions`, `_check_domains`, `save_concept`, `create_concept`, `delete_concept` and the existing behaviour of `changes.diff` stay as they are; `changes.diff` may gain keyword arguments with defaults that keep today's output. The checker (`backend/app/checkers/terminology.py`) and `backend/tests/data/terminology_baseline.json` are not edited.
- **No schema change.** No table, column or index is added.
- **Nothing under `clients/` changes.**
- **Commit trailer on every commit:** `Co-Authored-By: <model> <noreply@anthropic.com>`, naming the model that makes the commit.
- **Backend commands** run from `backend/` with `rtk proxy uv run …`; **frontend commands** from `frontend/` with `rtk proxy npm …`. The shell's working directory is reset between calls: put `cd /Users/markus/IdeaProjects/fabulous-writing/<dir> && …` in the same command. `ruff` is not installed locally.
- **Backend gate (Tasks 1 to 4, 10):** `rtk proxy uv run pytest -q` green with zero warnings, once without and once with the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (the controller confirms the local stack is up before Task 1).
- **Frontend gate (Tasks 5 to 9):** `rtk proxy npm test`, `rtk proxy npm run lint` and `rtk proxy npm run build` all green; lint adds no new warning.
- **Mutation-verify every new behaviour test:** change the rule it pins, watch the test fail, restore by re-editing the file (never `git checkout <file>`, never a scripted text replacement). A test that asserts on rendered output must wait for the render (`findBy…`/`waitFor`) before asserting, or its mutation proves nothing. State in the task report which mutation was run and how the test failed.
- **User-facing text** is added to `frontend/src/i18n/messages.ts` and all seven catalogs (`en`, `de`, `es`, `fr`, `it`, `ja`, `zh`) in the same commit, in the informal register (`register.test.ts`). The English texts are the mockup's, verbatim, with typographic quotes.
- **Styling** follows the mockup. Existing classes are used where the mockup names them (`dialog.app-dialog` through `ui/Dialog`, `.plain-button`, `.primary-button`, `.confirm-dialog-danger`, `.status-chip` through `StatusChip`, `.language-marker`, `.link-button`). New rules use the theme tokens only (`--held-back` for the amber edge); no new colour literals.
- **Status is never shown by colour alone.** An incoming term's mark is the text "+" plus an accessible name.
- **No comments that retell the code.** Prefer the simplest correct solution.
- **Suite runtime:** report a task that adds more than 2 s to the backend suite (about 21 s on SQLite) or to `npm test`.
- **Ports 5173 and 8000** belong to the owner's dev servers. Never start, stop or bind anything there. Never touch `backend/data/fabulous.db` or `backend/config.yaml`.

## Readings of the spec that this plan fixes

A reviewer checks the code against these.

1. **Names.** Store: `merge_concept`, `move_term`, private `_transfer`. Models in `model.py`: `SectionBasis`, `ConceptBasis`, `TransferBasis`, `MovedTerm`, `DroppedTerm`, `DroppedDefinition`, `DomainRef`, `TransferOutcome`, and the error `TransferOutdatedError(TerminologyRuleError)` with rule `outdated` and the attribute `concept_id`. Actions `Action.MOVED = "moved"`, `Action.MERGED = "merged"`.
2. **Basis shape.** `TransferBasis = {source: ConceptBasis, target: ConceptBasis | null}`; `ConceptBasis = {concept_id, revision, sections: [{id, revision}]}`. `target` is null for a new concept. A basis matches the stored state when, for source and target, concept id and revision match and the sets of `(id, revision)` pairs match; order is irrelevant. A basis whose target does not fit the request (another concept id, or null against an id, or the reverse) does not match.
3. **Rule codes** (409, `{code, message}`): `same_concept`, `owner_mismatch`, `duplicate_text` (a move onto an existing wording; the existing code of that rule), `outdated` (the basis does not match). `outdated` carries `concept_id`: the source if the source differs, otherwise the target. It is not a `TerminologyConflictError`, whose `part` means a language.
4. **Reads, locks and checks in `_transfer`, in this order.**
   1. Without locks: find the concept of the term (move) and, for a new concept, the source's domain ids. A term that does not exist: `None`.
   2. Lock with `_lock`: those domain ids (new concept only), then source and target concept.
   3. Load both concepts again. `None` if either is missing or invisible to the actor. If the term is no longer in the source found in step 1, or the source's domain ids differ from the ones locked: `TransferOutdatedError` for the source, for a preview too.
   4. `require_writable` on both; `same_concept`; `owner_mismatch`; the basis (real run only).
   5. The rules of spec 4.2 to 4.5, through `plan_transfer`.
5. **Writes, in this order,** because terms are deleted with their section and sections with their concept (`ON DELETE CASCADE`): create the new concept and its links (new concept only); create missing target sections; move the terms (Reading 6); write adopted definitions and raise the target sections; delete dropped duplicate terms; delete removed source sections or the source concept; raise the surviving source sections and the concepts. `rows.apply_sections` is never used on the source: it deletes terms by id and would delete a term that has just moved. Every term UPDATE must change exactly one row.
6. **A term's move is one UPDATE:** `section_id`, `usage_status`, `revision = revision + 1`, `modified_at`, `modified_by`. The row and its `id` and `uid` are kept.
7. **Version numbers, exactly:** a target section that receives terms or a definition: +1, once. A created section starts at 1. A source section that loses a term and survives: +1. A concept whose set of languages changes: +1, once per run (`rows.touch_concept`). A new concept and its sections start at 1.
8. **"Has no definition"** (spec 4.4) means the definition is the empty string after `strip()`.
9. **`removed_languages`** lists source languages whose section was removed while the source survives. For a deleted source it is empty.
10. **`dropped_definitions`** lists every non-blank definition of a removed source section that the target did not take over, for a merge and for a move alike, also when the source is deleted.
11. **Domain reports** are computed from the links before the run: `dropped_domains = source − target`, `added_domains = target − source`, each sorted by name. Both are empty for a new concept.
12. **A preview** runs steps 1 to 5 of Reading 4 and the writes of Reading 5, loads the outcome, and rolls back: a private exception carrying the outcome is raised inside the `with self._connect()` block and caught outside it. For a new concept, `target` is the concept as loaded before the rollback and `basis.target` is null. On Postgres a rolled-back insert still consumes an id, so a preview and the real run after it may differ in the ids of rows they create, and in nothing else.
13. **Change log, exactly.** One batch; `_record` is not used, because it would log moved terms as created and deleted.
    - Per moved term one `moved` entry with `concept_id`/`concept_uid` of the target, the labels of the target after the run, and `changes = [{field: "concept", old: <source uid>, new: <target uid>}]` plus `{field: "usage_status", old, new}` when it changed.
    - For the target and for a surviving source: the entries of `changes.diff(before, after)` without those whose `term_id` is a moved term. That yields the `edited` concept entries for definitions and nothing else in the cases this operation produces, apart from `deleted` entries for dropped duplicates on the source side.
    - For a deleted source: the entries of `changes.diff(source_before, None)` without those of moved terms, so that labels and last values come from the source as it was. In a merge the concept entry's action is `merged` and its changes start with `{field: "merged_into", old: null, new: <target uid>}`. Dropped duplicates keep their `deleted` entries. No extra `edited` entry.
    - For a new concept: the concept entry of `changes.diff(None, after)` without its term entries.
14. **Feature gate.** `POST /api/terms/{id}/move` with `target_id: null` calls the existing `_require_custom_domains`, for a preview too.
15. **Screen: availability.** Both actions are rendered only for a saved concept that is not read-only. They are disabled while `busy` or `unsaved`. "Merge into…" is also disabled when the candidate list is empty. "Move…" is rendered for terms that have an id. A typed "reason for this change" alone does not count as unsaved (it does not today).
16. **Screen: candidates** are the concepts of the active domain as the view holds them, without the open concept.
17. **Screen: suggestions.** Concepts whose label in the list language starts with the query (case-insensitive) first, then other matches (`matchesQuery`), each group in `sortByLabel` order. An empty query lists all candidates in `sortByLabel` order. A row's other wordings are those of the language its label came from. No match: one row with the text of Reading 21.
18. **Screen: order of chips in a result row:** by usage status (preferred, admitted, deprecated, forbidden), then by term id.
19. **Screen: after the run.** The view first replaces the target and the source in its list with the concepts of the outcome (a deleted source is removed), then shows the entry through `showEntry` with a new object, then reloads the active domain's concepts. Merge: the entry shows `outcome.target`. Move: `outcome.source`, or `outcome.target` when `source` is null. The entry element's `key` is a counter the view raises on each transfer, so the entry is remounted and builds its state from the patched list; saving a new concept does not change the key. The remount clears the reason field.
20. **Screen: while a real run is pending,** the dialog cannot be closed: Cancel is disabled and the dialog's `onClose` does nothing. The view still binds the callback to the entry that opened the dialog, as `conceptSaved` is bound, and compares it with `openRef`: for an entry it has closed in the meantime it patches and reloads the list and opens nothing.
21. **Screen: errors and texts the mockup does not show.** A failed preview shows the server's message in place of the result and leaves confirm unavailable; for `duplicate_text` the dialog shows the mockup's sentence built from the catalog. A real run refused as `outdated` shows the mockup's sentence naming the concept with that `concept_id` and requests a new preview. Any other failure of the real run shows its message and keeps the dialog open. English texts missing from the mockup: `No concept matches.` (suggestion list); `The term now also applies in the domain “Marketing”.` (move); `“work space” loses German.` (a lost language without a definition); `The German definition is not taken over: “…”` (move that deletes the source and drops a definition).

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/services/terminology/model.py` | New actions, the transfer models and the error (Reading 1). |
| `backend/app/services/terminology/transfer.py` (new) | `plan_transfer`: pure decision of what happens to each term, definition and section; no database access. |
| `backend/app/services/terminology/rows.py` | Row helpers: move a term, insert/update/delete a section, find a term's concept. |
| `backend/app/services/terminology/changes.py` | `transfer_entries`: the log entries of Reading 13. |
| `backend/app/services/terminology/store.py` | `_transfer`, `merge_concept`, `move_term`, preview by rollback. |
| `backend/app/api/terminology.py` | The two endpoints. |
| `backend/tests/test_terminology_transfer_plan.py`, `test_terminology_transfer.py`, `test_terminology_transfer_api.py` (new) | Planner, store and API tests. |
| `backend/tests/test_terminology_concurrency.py` | One raced pair. |
| `frontend/src/types.ts`, `frontend/src/api/client.ts` | `TransferOutcome` types; `mergeConcept`, `moveTerm`. |
| `frontend/src/terminology/transfer.ts` (new) | Pure functions: suggestions, highlight parts, result rows, notices. |
| `frontend/src/terminology/TargetPicker.tsx`, `useTransferPreview.ts` (new) | Search field with suggestion list; preview requests where only the latest answer counts. |
| `frontend/src/terminology/StatusChip.tsx` | An `incoming` prop. |
| `frontend/src/terminology/MergeDialog.tsx`, `MoveDialog.tsx` (new) | The two dialogs. |
| `frontend/src/terminology/ConceptEntry.tsx`, `LanguageSectionEditor.tsx`, `TerminologyView.tsx` | The two buttons, opening the dialogs, what the entry shows afterwards. |
| `frontend/src/i18n/*`, `frontend/src/App.css` | Texts and styles. |

---

### Task 1: Models and the decision of a transfer

**Files:**
- Create: `backend/app/services/terminology/transfer.py`, `backend/tests/test_terminology_transfer_plan.py`
- Modify: `backend/app/services/terminology/model.py`

**Interfaces:**
- Produces:
  - Everything of Reading 1. `MovedTerm{id, text, language, usage_before, usage_after}`, `DroppedTerm{text, language, usage_status}`, `DroppedDefinition{language, definition}`, `DomainRef{id, name}`, `TransferOutcome{target: Concept, source: Concept | None, moved, dropped_terms, dropped_definitions, removed_languages: list[Language], dropped_domains, added_domains, basis: TransferBasis}`.
  - `transfer.basis_of(concept: Concept) -> ConceptBasis` and `transfer.basis_matches(basis: ConceptBasis, concept: Concept) -> bool` (Reading 2).
  - `transfer.plan_transfer(source: Concept, term_ids: list[int], target: Concept | None, *, merge: bool) -> TransferPlan`, a frozen dataclass: `moves: list[PlannedMove]` (`term: ConceptTerm`, `language`, `usage_after`), `dropped: list[tuple[Language, ConceptTerm]]`, `removed_languages: list[Language]`, `adopted_definitions: dict[Language, str]`, `dropped_definitions: list[DroppedDefinition]`, `source_deleted: bool`. Raises `TerminologyRuleError("duplicate_text", …)` for a move onto an existing wording.

- [ ] **Step 1: Write failing tests** on in-memory `Concept` objects (a small local factory), one test per rule:
  - `test_term_keeps_its_usage_status_when_the_target_has_no_active_preferred`
  - `test_active_preferred_becomes_admitted_next_to_an_active_preferred` (the target's term is not in `moves`)
  - `test_candidate_preferred_is_not_demoted`, `test_preferred_stays_next_to_a_candidate_preferred`
  - `test_move_onto_the_same_wording_is_refused` (`duplicate_text`)
  - `test_wording_that_differs_only_in_case_is_not_a_duplicate` ("Workspace" next to "workspace": moved, kept)
  - `test_last_term_of_a_language_removes_the_section`, `test_last_term_of_the_concept_deletes_it`
  - `test_definition_of_a_removed_section_is_adopted_by_a_target_without_one` (target section missing; target definition `"  "`; target `None`)
  - `test_definition_of_a_removed_section_is_dropped_when_the_target_has_one` (also when the source is deleted, Reading 10)
  - `test_definition_stays_with_a_section_that_keeps_a_term`
  - `test_merge_moves_every_term_and_deletes_the_source`
  - `test_merge_drops_an_incoming_duplicate_and_keeps_the_target_term`
  - `test_merge_drops_a_preferred_duplicate_without_promoting_the_target_term` (the dropped term is not demoted first)
  - `test_basis_matches_ignores_order_and_sees_every_difference` (concept revision, a section revision, a section id, an extra section)
- [ ] **Step 2:** Run `rtk proxy uv run pytest -q tests/test_terminology_transfer_plan.py`; expect failures on the missing module.
- [ ] **Step 3:** Implement. The wording is compared before the preferred rule (spec 4.2).
- [ ] **Step 4:** Run the file, then the backend gate on SQLite.
- [ ] **Step 5:** Mutation-verify the demotion, the wording comparison (make it case-insensitive), and the merge's dropping.
- [ ] **Step 6:** Commit: `feat(terminology): decide a move or merge of terms`.

### Task 2: Move one term to an existing concept

**Files:**
- Modify: `backend/app/services/terminology/rows.py`, `changes.py`, `store.py`
- Create: `backend/tests/test_terminology_transfer.py`

**Interfaces:**
- Consumes: Task 1; `rows.load_concept`, `_lock`, `require_writable`, `is_visible`, `rows.domain_names`, `changes.diff`, `changes.write`.
- Produces:
  - `TerminologyStore.move_term(term_id: int, target_id: int | None, *, basis: TransferBasis | None, preview: bool = False, actor: Actor, comment: str = "") -> TransferOutcome | None`. In this task `target_id=None` raises `NotImplementedError`.
  - Private `_transfer(conn, …)` implementing Readings 4 to 13 for an existing target, written so that Task 3 adds the merge and the new concept without restructuring it.
  - `changes.transfer_entries(...) -> list[Entry]` (Reading 13; signature left to the implementer).
  - A test helper `comparable(outcome) -> dict` in the test file: the outcome as a dict without the ids of sections and concepts the run created (Reading 12).

- [ ] **Step 1: Write failing store tests** (fixture: a `TerminologyStore` on the suite's database fixture, as `test_terminology_store.py` builds it, so they run on both databases; `store._utcnow` monkeypatched to a fixed value wherever two outcomes are compared):
  - `test_moved_term_keeps_id_uid_and_fields`
  - `test_version_numbers_after_a_move` (Reading 7: receiving section +1, losing section +1, moved term +1; a move that creates a target section and removes a source section raises both concepts by exactly 1)
  - `test_outcome_reports_moves_definitions_languages_and_domains` (Readings 9 to 11, with a source in two domains and a target in two, one shared)
  - `test_real_run_needs_the_basis_of_the_preview` (basis from a preview, then the target is saved through `save_concept`; the run raises `TransferOutdatedError` with the target's id and writes nothing: both concepts and the row count of `terminology_changes` are unchanged)
  - `test_outdated_names_the_source_first`, `test_basis_for_another_target_is_outdated`
  - `test_preview_writes_nothing_and_matches_the_real_run` (after the preview both concepts and the change-log count are as before; the real run with the preview's basis gives `comparable(real) == comparable(preview)`; the case creates a target section)
  - `test_same_concept_and_other_owner_are_refused` (`same_concept`; `owner_mismatch` with a global target and an own source, as admin)
  - `test_invisible_or_missing_is_not_found` (returns `None`: another user's concept as source or as target; a term id that does not exist)
  - `test_non_admin_cannot_move_between_global_concepts` (`GlobalReadOnlyError`, for a preview too)
  - `test_moved_term_survives_the_removal_of_its_old_section_and_concept` (Reading 5: after a move that deletes the source, the term row exists with the same id)
  - `test_change_log_of_a_move` (Reading 13: one batch; one `moved` entry on the target with the `concept` change and, when demoted, `usage_status`; no `created` or `deleted` entry for the moved term; `edited` entries for an adopted and for a dropped definition; when the source is emptied, a `deleted` concept entry whose labels are those of the source before the run, and no term entries; the comment on every entry)
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement the row helpers, `changes.transfer_entries`, `_transfer` and `move_term`.
- [ ] **Step 4:** Backend gate on both databases.
- [ ] **Step 5:** Mutation-verify: the basis comparison; the rollback of a preview (make the preview commit and watch `test_preview_writes_nothing…` fail); the order of Reading 5 (delete the source section before moving and watch the survival test fail); the filter that keeps moved terms out of `created`/`deleted`.
- [ ] **Step 6:** Commit: `feat(terminology): move a term to another concept`.

### Task 3: Merge, and a new concept as target

**Files:**
- Modify: `backend/app/services/terminology/changes.py`, `store.py`, `backend/tests/test_terminology_transfer.py`, `backend/tests/test_terminology_concurrency.py`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `TerminologyStore.merge_concept(source_id: int, target_id: int, *, basis: TransferBasis | None, preview: bool = False, actor: Actor, comment: str = "") -> TransferOutcome | None`.
  - `move_term(..., target_id=None, ...)` creates a concept with the source's owner and domain links (`rows.insert_concept`, `rows.set_links`).

- [ ] **Step 1: Failing tests.**
  - `test_merge_outcome` (the "everything at once" case of the mockup's section 3: three languages, one duplicate, one adopted and one dropped definition, one dropped and one added domain; assert every field of the outcome and that the source is gone)
  - `test_merge_raises_the_target_concept_by_one_for_several_new_languages`
  - `test_change_log_of_a_merge` (Reading 13: a `merged` entry with `merged_into` first and the labels of the source before the run; `deleted` for the duplicate; `moved` for the others; no `created`, `deleted` or `edited` entry for a moved term; no `edited` entry for the source)
  - `test_merge_preview_writes_nothing_and_matches_the_real_run` (with `comparable`)
  - `test_move_to_a_new_concept` (owner and domain links of the source; the term keeps `id`, `uid` and its usage status, also when preferred; the new section starts at 1; the definition is adopted only when the source section was removed; both domain reports empty; `basis.target` is `None`)
  - `test_change_log_of_a_split` (a `created` concept entry without term entries, one `moved` entry)
  - `test_preview_of_a_new_concept_leaves_no_concept` (the count of concepts is unchanged)
  - `test_source_whose_domains_changed_after_the_read_is_outdated` (Reading 4, step 3: patch the unlocked read to return a stale domain list)
  - Concurrency, in `test_terminology_concurrency.py`, with OS processes and the Postgres fixture as the tests there do: `test_two_merges_of_the_same_pair_in_opposite_directions` (A into B and B into A at once, each with a basis read before: exactly one succeeds, the other gets `outdated` or `None`, neither is still running when the test's timeout ends, and one concept with all terms remains).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Backend gate on both databases.
- [ ] **Step 5:** Mutation-verify: the `merged` action; the domain links of a new concept; the lock order, by editing `_lock` so that it no longer sorts concept ids and watching the concurrency test fail on Postgres (state in the report if it cannot be made to fail, and why).
- [ ] **Step 6:** Commit: `feat(terminology): merge concepts and split a term off`.

### Task 4: Endpoints

**Files:**
- Modify: `backend/app/api/terminology.py`
- Create: `backend/tests/test_terminology_transfer_api.py`

**Interfaces:**
- Consumes: `merge_concept`, `move_term`, `TransferOutdatedError`, `_concept_errors`, `_actor`, `_require_custom_domains`.
- Produces:
  - `POST /api/concepts/{concept_id}/merge`, body `{target_id: int, preview: bool = false, basis: TransferBasis | null = null, comment: str = ""}`.
  - `POST /api/terms/{term_id}/move`, body the same with `target_id: int | null`.
  - Both answer 200 with `TransferOutcome` as it serialises (concepts without `owner_id`, with `is_global`). A real run without `basis` is a 422 from the body model.

- [ ] **Step 1: Failing tests** with the helpers of `terminology_helpers.py`:
  - `test_merge_preview_then_run`, `test_move_preview_then_run` (preview 200 and nothing changed; run with the returned basis 200; the list of the domain shows the result)
  - `test_run_without_basis_is_422`
  - `test_outdated_basis_is_409_with_the_concept_id` (`detail == {"code": "outdated", "message": …, "concept_id": …}`)
  - `test_rule_errors_are_409_objects` (`same_concept`, `owner_mismatch`, `duplicate_text`)
  - `test_unknown_or_foreign_ids_are_404` (source, target, term; for a second user's rows)
  - `test_non_admin_gets_403_on_global_concepts` (preview and run)
  - `test_new_concept_needs_the_feature` (tier without `custom_domains`: 403 for preview and run; a move to an existing concept still works)
  - `test_comment_reaches_the_change_log`
- [ ] **Step 2:** Run; expect 404s for the missing routes.
- [ ] **Step 3:** Implement both routes; `_concept_errors` adds `concept_id` to the detail for `TransferOutdatedError`.
- [ ] **Step 4:** Backend gate on both databases.
- [ ] **Step 5:** Mutation-verify the basis requirement and the feature gate.
- [ ] **Step 6:** Commit: `feat(api): merge and move endpoints`.

### Task 5: Types, client and the dialogs' logic

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`
- Create: `frontend/src/terminology/transfer.ts`, `frontend/src/terminology/transfer.test.ts`

**Interfaces:**
- Consumes: `conceptLabel`, `otherWordings`, `conceptLanguages`, `matchesQuery`, `sortByLabel` from `labels.ts`.
- Produces:
  - Types `TransferBasis`, `MovedTerm`, `DroppedTerm`, `DroppedDefinition`, `DomainRef`, `TransferOutcome` mirroring Task 4's JSON.
  - `mergeConcept(sourceId: number, body: {target_id: number; preview?: boolean; basis?: TransferBasis; comment?: string}): Promise<TransferOutcome>`, `moveTerm(termId: number, body: {target_id: number | null; …same}): Promise<TransferOutcome>`.
  - `HttpError` gains `conceptId?: number`, read from the 409 detail like `part`.
  - `suggest(candidates: Concept[], query: string, language: Language, order: Language[]): Concept[]` (Reading 17).
  - `suggestionRow(concept: Concept, language: Language, order: Language[]): {label: ConceptLabel; others: ConceptTerm[]; languages: Language[]}` (others in the label's language).
  - `highlight(text: string, query: string): {text: string; match: boolean}[]` (every case-insensitive occurrence; one part with `match: false` for an empty query).
  - `resultRows(outcome: TransferOutcome, order: Language[]): {language: Language; terms: {term: ConceptTerm; incoming: boolean}[]; demoted: string[]}[]`: the target's sections in `conceptLanguages` order, terms in the order of Reading 18; `incoming` for ids in `outcome.moved`; `demoted` the wordings whose usage changed from preferred to admitted.
  - `notices(outcome: TransferOutcome, kind: 'merge' | 'move'): Notice[]`, a tagged union: `{kind: 'droppedTerm', text, language, usageStatus}`, `{kind: 'droppedDefinition', language, definition}`, `{kind: 'droppedDomain', name}`, `{kind: 'addedDomain', name}`, `{kind: 'demoted', text}`, `{kind: 'lostLanguage', language, definition: string | null}`, `{kind: 'sourceDeleted'}`. For `'merge'`: dropped terms, dropped definitions, dropped domains, in that order (demotions and added domains are shown elsewhere in that dialog). For `'move'`: demoted; lost language, each with the dropped definition of that language or null; dropped definitions of languages not in `removed_languages` (Reading 10, a deleted source); dropped domain; added domain; source deleted; in that order.

- [ ] **Step 1: Failing tests** in `transfer.test.ts`, with outcome fixtures written as literals:
  - `suggest`: prefix matches before other matches; both groups alphabetical; a match only in another language is found; an empty query returns all in label order; the fallback label decides the prefix group for a concept without a term in the list language. `suggestionRow`: others come from the label's language.
  - `highlight`: several occurrences, case-insensitive, original casing kept, no match, empty query.
  - `resultRows`: language order, chip order, incoming flags, demoted wordings, a language that only exists through incoming terms.
  - `notices`: each kind for merge and for move, the two orders, a dropped definition of a deleted source in a move, and an outcome with nothing to report gives `[]` for both.
  - client: `mergeConcept` and `moveTerm` send the body to the right URL (as the neighbouring client tests do); a 409 with `concept_id` sets `HttpError.conceptId`.
- [ ] **Step 2:** `rtk proxy npx vitest run src/terminology/transfer.test.ts`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the prefix-first order and the notice order of a move.
- [ ] **Step 6:** Commit: `feat(terminology): client and logic for merge and move`.

### Task 6: Target picker and preview hook

**Files:**
- Create: `frontend/src/terminology/TargetPicker.tsx`, `TargetPicker.test.tsx`, `useTransferPreview.ts`, `useTransferPreview.test.tsx`
- Modify: `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`

**Interfaces:**
- Consumes: `suggest`, `suggestionRow`, `highlight`; `useMessages`; `languageName`.
- Produces:
  - `<TargetPicker candidates language order target onPick(concept | null) disabled />`. Without a target: a text field (placeholder `searchConceptsPlaceholder`, accessible name the mockup's "Into") and the suggestion list as a listbox, rows as in the mockup's section 2; arrow keys move the active row, Enter picks it; no match shows the row of Reading 21. With a target: its label and a "Change" link button that calls `onPick(null)`; the field then has focus again.
  - `useTransferPreview(run: (() => Promise<TransferOutcome>) | null): {outcome: TransferOutcome | null; loading: boolean; error: HttpError | null; reload: () => void}`. `run` must be stable between renders (callers memoise it); a new `run` or `reload` starts a request and clears the previous outcome and error; an answer is applied only if it belongs to the latest request and the component is mounted; `null` clears everything.

- [ ] **Step 1: Failing tests.**
  - Picker: lists all candidates on opening; narrows and reorders while typing; highlights every match; shows the fallback language marker; picks by click and by arrow keys plus Enter; shows the "no match" row; "Change" calls `onPick(null)` and focuses the field.
  - Hook: loading, then outcome; an error; a late answer of an earlier `run` does not replace the later one (two controlled promises resolved in reverse order); `reload` repeats the request; unmounting while pending causes no state update (no act warning); the same `run` on a re-render starts no second request.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement, with the texts and the styles of the mockup's section 2.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the latest-request rule and the keyboard pick.
- [ ] **Step 6:** Commit: `feat(terminology): target picker and transfer preview`.

### Task 7: The merge dialog

**Files:**
- Create: `frontend/src/terminology/MergeDialog.tsx`, `MergeDialog.test.tsx`
- Modify: `frontend/src/terminology/StatusChip.tsx`, `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`

**Interfaces:**
- Consumes: Tasks 5 and 6; `ui/Dialog`; `StatusChip`.
- Produces:
  - `StatusChip` gains `incoming?: boolean`: the visible "+" of the mockup and the accessible name extended by the catalog's word for an incoming term, since the chip is `role="img"` with its own label.
  - `<MergeDialog source candidates language order comment onDone(outcome: TransferOutcome) onClose />`.
- The dialog's states are the mockup's sections 2 to 4: picking (confirm unavailable); waiting ("Working out the result…", confirm unavailable); result (rows from `resultRows`, the demotion lines, the box "Not taken over" only with notices, the added-domains line only with added domains); out of date (Reading 21). Confirm calls `mergeConcept` with `outcome.basis` and the comment, and then `onDone`. While that request runs the dialog follows Reading 20.

- [ ] **Step 1: Failing tests** in `MergeDialog.test.tsx` (client functions mocked as in `ConceptEntry.test.tsx`):
  - confirm is unavailable before a target is picked and while the preview is loading
  - picking a target requests a preview for it
  - renders the result of the "everything at once" outcome: chips per language in the order of Reading 18, the incoming mark with its accessible name on incoming terms only, both demotion lines, three notices, the added-domain line
  - renders no box and no added-domain line for the simple outcome
  - "Change" clears the result and returns to the field
  - confirm sends the basis on display and the comment, then calls `onDone` with the answer; while it runs, confirm and Cancel are unavailable and Escape does not close the dialog
  - an `outdated` refusal shows the sentence with the changed concept's label and a fresh preview, and confirm then sends the new basis
  - a failed preview shows its message and keeps confirm unavailable; another failure of the run shows its message and keeps the dialog open
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement, with texts (all seven catalogs) and styles; open the mockup and match sections 3 and 4.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the disabled confirm during a run, the blocked close, and the hidden box for an empty notice list.
- [ ] **Step 6:** Commit: `feat(terminology): merge dialog`.

### Task 8: The move dialog

**Files:**
- Create: `frontend/src/terminology/MoveDialog.tsx`, `MoveDialog.test.tsx`
- Modify: `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`

**Interfaces:**
- Consumes: `TargetPicker`, `useTransferPreview`, `notices`, `moveTerm`.
- Produces: `<MoveDialog source term candidates language order comment canCreate onDone(outcome) onClose />`. `canCreate` false hides "To a new concept" (Reading 14).
- States are the mockup's section 5. "To the concept" is selected on opening. A preview is requested when a target is picked or "To a new concept" is chosen. The box "This also happens" appears only with notices. For a new concept the line "The new concept is in the same domains as …" is shown. The confirm button is "Move", or red "Move and delete …" when `outcome.source` is null. Reading 20 applies.

- [ ] **Step 1: Failing tests** in `MoveDialog.test.tsx`:
  - "Move" is unavailable before a choice is complete; no box for a move without side effects
  - each notice kind renders its sentence, including the three of Reading 21
  - red confirm naming the concept when the source is deleted, plain "Move" otherwise
  - choosing "To a new concept" requests a preview with `target_id: null` and shows the domains line; the option is absent without `canCreate`
  - a `duplicate_text` refusal of the preview shows the mockup's sentence with target label, wording and language name, and "Move" is unavailable
  - switching between the two choices keeps a picked target and requests the matching preview
  - confirm sends the basis and the comment and calls `onDone`; the dialog cannot be closed while it runs
  - an `outdated` refusal shows the sentence and a fresh preview
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement, with texts and styles, matching the mockup's section 5.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the red-button condition and the `canCreate` gate.
- [ ] **Step 6:** Commit: `feat(terminology): move dialog`.

### Task 9: The two buttons and what the entry shows afterwards

**Files:**
- Modify: `frontend/src/terminology/ConceptEntry.tsx`, `LanguageSectionEditor.tsx`, `TerminologyView.tsx`, their test files, `frontend/src/i18n/*`, `frontend/src/App.css`

**Interfaces:**
- Consumes: `MergeDialog`, `MoveDialog`.
- Produces:
  - `ConceptEntry` props: `candidates: Concept[]`, `canCreate: boolean`, `onTransferred(outcome: TransferOutcome, kind: 'merge' | 'move'): void`. It renders "Merge into…" before "Remove from this domain" and opens the dialogs (Reading 15), passing its `comment`. The test helper `renderEntry` gets defaults for the three props.
  - `LanguageSectionEditor` props: `onMoveTerm?: (termId: number) => void`, `moveBlocked: boolean`; "Move…" at the end of a term's details, as in the mockup's section 1.
  - `TerminologyView`: passes the candidates (Reading 16) and `canCreate`; a function `conceptTransferred(entry: OpenConcept, outcome, kind)` bound as `conceptSaved` is, implementing Readings 19 and 20.

- [ ] **Step 1: Failing tests.**
  - `ConceptEntry.test.tsx`: both buttons absent for a new concept and for a read-only one; disabled with unsaved changes and while a save runs; "Merge into…" disabled without candidates; "Move…" absent for a term without an id; a typed reason alone leaves them enabled and reaches the dialog's request as `comment`; the dialogs open and close; `onTransferred` is called with the outcome and the kind.
  - `TerminologyView.ownership.test.tsx`: after a merge the entry shows the target with the incoming term before the reload answers (hold the reload back with a controlled promise), and the list is reloaded; after a move the entry shows the source without the term, with the revisions of the outcome (the next language save sends them) and an empty reason field; after a move that deletes the source the entry shows the target; saving a new concept does not remount the entry (a typed reason survives it); the candidates exclude the open concept; for an entry the view has closed in the meantime, the answer patches and reloads the list and opens nothing.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the unsaved guard on both buttons, the patch before the remount (remove it and watch the stale-entry test fail), and the closed-entry case.
- [ ] **Step 6:** Commit: `feat(terminology): merge and move from the concept entry`.

### Task 10: Documentation

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `docs/architecture-atlas/atlas-data.js`, `README.md`

- [ ] **Step 1:** Backend architecture: the two endpoints in the endpoint table; the transfer operation (one function, the order of reads, locks and writes, the basis); preview by rollback, including that a preview takes the same locks as a run and on SQLite waits behind writers; the two new log actions.
- [ ] **Step 2:** Frontend architecture: `transfer.ts`, the picker, the two dialogs, the preview hook under "Answers that arrive late", what the entry shows afterwards.
- [ ] **Step 3:** Atlas: add the new modules where the terminology modules are listed; run the check the file's header names.
- [ ] **Step 4:** README: one or two sentences in the terminology section on merging, moving and splitting.
- [ ] **Step 5:** Backend gate (SQLite is enough here) and frontend gate; commit: `docs: merging concepts and moving terms`.

## Review Focus

Failure modes the spec implies but states no test for; each has its test in the task named.

1. **A wording that differs only in case** from a target term is moved and kept, not treated as a duplicate (Task 1).
2. **A moved term must survive the removal of its old section or concept** (Task 2, the survival test).
3. **Two merges of the same pair in opposite directions** end with one concept, no deadlock and no lost term (Task 3).
4. **A late preview answer** for a target the writer has already replaced must not be shown or confirmed (Task 6).
5. **The entry after a move must not be built from the list as it was before** (Task 9, the held-back reload).

Also pinned: a double click on confirm sends one request (Task 7); a typed reason without other edits does not block the actions, reaches the log and is gone afterwards (Task 9).

## Execution Plan

Sequential, one agent at a time. Implementers on the mid tier; the review of the store work (R1) and the final review on the most capable model.

| Step | What | Review |
|---|---|---|
| Tasks 1 to 4 | Planner, store, API | **R1** after Task 4: spec 4 and 5, Readings 1 to 14 |
| Tasks 5 to 9 | Client, picker, dialogs, wiring | **R2** after Task 9: spec 6, Readings 15 to 21, the mockup side by side with the rendered dialogs |
| Trial | In the browser, by the controller, on its own scratch stack (own `config.yaml` with a scratch SQLite file, ports other than 5173 and 8000, placeholder provider keys): merge two single-term concepts; the "everything at once" merge; a move with and without side effects; a split; a refused move; an out-of-date merge provoked from a second browser context; a non-admin on a shared domain. Screenshots of each dialog state are compared with the mockup. | |
| Task 10 | Documentation | |
| Final review | Whole branch | Most capable model |

Delivery is one pull request.

## Plan review

Reviewed once by an independent reviewer on the most capable model before execution. Its two blockers (the entry rebuilt from a stale list; previews and runs differing in created ids on Postgres) and its other points are worked in: Readings 4, 5, 12, 13, 19 and 20, the split of the former Tasks 1 and 5, `TransferOutdatedError`, the notice for a definition dropped with a deleted source, and the `incoming` prop of `StatusChip`.
