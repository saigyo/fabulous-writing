# Terminology: Moving Terms and Merging Concepts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A writer can merge a concept into another one, move one term to another concept, and split a term off into a new concept, each after a preview that shows exactly what will happen.

**Architecture:** One store function, `_transfer`, moves a set of terms from a source concept to a target and is the only place the rules live. Two store methods call it (merge: all terms; move: one term), and each can run as a preview: the same code in the same transaction, which is then rolled back. Two endpoints expose them. In the browser, a module of pure functions turns the server's answer into what the dialogs show; two dialogs render it; the concept entry opens them.

**Tech Stack:** Python 3, FastAPI, Pydantic v2, SQLite and Postgres through the shared database seam, pytest. React 19, TypeScript, zustand, vitest with Testing Library, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-27-terminology-move-and-merge-design.md` ("the spec") with its mockup `docs/superpowers/specs/2026-11-27-terminology-move-and-merge-mockup.html` ("the mockup"). It builds on `docs/superpowers/specs/2026-11-22-terminology-t1-concept-model-design.md` ("the concept spec"), sections 5.3, 5.4, 5.7 and 7. Executors read the spec and, for Tasks 5 to 7, open the mockup.

## Global Constraints

- **Branch:** all work on `terminology-move-merge`, which already holds the spec and this plan. Never commit to `main`.
- **Existing rules do not change.** `_validate`, `_check_versions`, `_check_domains`, `save_concept`, `create_concept`, `delete_concept` and the existing behaviour of `changes.diff` stay as they are; `changes.diff` may gain keyword arguments with defaults that keep today's output. The checker (`backend/app/checkers/terminology.py`) and `backend/tests/data/terminology_baseline.json` are not edited.
- **No schema change.** No table, column or index is added.
- **Nothing under `clients/` changes.**
- **Commit trailer on every commit:** `Co-Authored-By: <model> <noreply@anthropic.com>`, naming the model that makes the commit.
- **Backend commands** run from `backend/` with `rtk proxy uv run …`; **frontend commands** from `frontend/` with `rtk proxy npm …`. The shell's working directory is reset between calls: put `cd /Users/markus/IdeaProjects/fabulous-writing/<dir> && …` in the same command. `ruff` is not installed locally.
- **Backend gate (Tasks 1 to 3, 8):** `rtk proxy uv run pytest -q` green with zero warnings, once without and once with the prefix `FW_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (the controller confirms the local stack is up before Task 1).
- **Frontend gate (Tasks 4 to 7):** `rtk proxy npm test`, `rtk proxy npm run lint` and `rtk proxy npm run build` all green; lint adds no new warning.
- **Mutation-verify every new behaviour test:** change the rule it pins, watch the test fail, restore by re-editing the file (never `git checkout <file>`, never a scripted text replacement). A test that asserts on rendered output must wait for the render (`findBy…`/`waitFor`) before asserting, or its mutation proves nothing. State in the task report which mutation was run and how the test failed.
- **User-facing text** is added to `frontend/src/i18n/messages.ts` and all seven catalogs (`en`, `de`, `es`, `fr`, `it`, `ja`, `zh`) in the same commit, in the informal register (`register.test.ts`). The English texts are the mockup's, verbatim, with typographic quotes.
- **Styling** follows the mockup. Existing classes are used where the mockup names them (`dialog.app-dialog` through `ui/Dialog`, `.plain-button`, `.primary-button`, `.confirm-dialog-danger`, `.status-chip` through `StatusChip`, `.language-marker`, `.link-button`). New rules use the theme tokens only (`--held-back` for the amber edge); no new colour literals.
- **Status is never shown by colour alone.** An incoming term's mark is the text "+" plus an accessible name.
- **No comments that retell the code.** Prefer the simplest correct solution.
- **Suite runtime:** report a task that adds more than 2 s to the backend suite (about 21 s on SQLite) or to `npm test`.
- **Ports 5173 and 8000** belong to the owner's dev servers. Never start, stop or bind anything there. Never touch `backend/data/fabulous.db` or `backend/config.yaml`.

## Readings of the spec that this plan fixes

A reviewer checks the code against these.

1. **Names.** Store: `merge_concept`, `move_term`, private `_transfer`. Models in `model.py`: `SectionBasis`, `ConceptBasis`, `TransferBasis`, `MovedTerm`, `DroppedTerm`, `DroppedDefinition`, `DomainRef`, `TransferOutcome`. Actions `Action.MOVED = "moved"`, `Action.MERGED = "merged"`.
2. **Basis shape.** `TransferBasis = {source: ConceptBasis, target: ConceptBasis | null}`; `ConceptBasis = {concept_id, revision, sections: [{id, revision}]}`. `target` is null for a new concept. Two bases are equal when concept ids and revisions match and the sets of `(id, revision)` pairs match; order is irrelevant.
3. **Rule codes** (409, `{code, message}`): `same_concept`, `owner_mismatch`, `duplicate_text` (a move onto an existing wording; the existing code of that rule), `outdated` (basis mismatch). `outdated` carries `concept_id`, the id of the first concept that differs, source before target. It is raised as `TerminologyRuleError` with rule `outdated`, not as `TerminologyConflictError`, whose `part` means a language.
4. **Order of checks in `_transfer`:** lock; load; 404 (`None`) if source or target is invisible, or a term does not belong to the source; `require_writable` on both; `same_concept`; `owner_mismatch`; basis (real run only); then the rules of spec 4.2 to 4.5.
5. **A term's move is one UPDATE:** `section_id`, `usage_status`, `revision = revision + 1`, `modified_at`, `modified_by`. The row and its `id` and `uid` are kept.
6. **Version numbers, exactly:** a target section that receives terms or a definition: +1, once. A created section starts at 1. A source section that loses a term and survives: +1. A concept whose set of languages changes: +1, once per run. A new concept and its sections start at 1.
7. **"Has no definition"** (spec 4.4) means the definition is the empty string after `strip()`.
8. **`removed_languages`** lists source languages whose section was removed while the source survives. For a deleted source it is empty.
9. **`dropped_definitions`** lists every non-blank definition of a removed source section that the target did not take over, for a merge and for a move alike.
10. **Domain reports** are computed from the links before the run: `dropped_domains = source − target`, `added_domains = target − source`, each sorted by name. Both are empty for a new concept.
11. **Preview of a new concept** returns `target` as loaded inside the rolled-back transaction, and `basis.target = null`.
12. **Change log, exactly.** One batch. Per moved term one `moved` entry with `concept_id`/`concept_uid` of the target, `changes = [{field: "concept", old: <source uid>, new: <target uid>}]` plus `{field: "usage_status", old, new}` when it changed. Moved terms get no other entry. A merge writes one `merged` entry for the source concept, `changes = [{field: "merged_into", old: null, new: <target uid>}]` followed by the changes a `deleted` concept entry lists today, and one `deleted` entry per dropped duplicate term. A source emptied by a move gets the usual `deleted` concept entry and no term entries. A new concept gets the usual `created` concept entry and no term entries. Definition changes on source and target produce the `edited` concept entries `changes.diff` writes today.
13. **Feature gate.** `POST /api/terms/{id}/move` with `target_id: null` needs `custom_domains`, for a preview too (403, the message of `create_domain`'s gate adapted to concepts as `create_concept`'s endpoint has it).
14. **Screen: availability.** Both actions are rendered only for a saved concept that is not read-only. They are disabled while `busy` or `unsaved`. "Merge into…" is also disabled when the candidate list is empty. "Move…" is rendered for terms that have an id. A typed "reason for this change" alone does not count as unsaved (it does not today).
15. **Screen: candidates** are the concepts of the active domain as the view holds them, without the open concept.
16. **Screen: suggestion order.** Concepts whose label in the list language starts with the query (case-insensitive) first, then other matches (`matchesQuery`), each group in `sortByLabel` order. An empty query lists all candidates in `sortByLabel` order.
17. **Screen: after the run.** The view reloads the active domain's concepts. Merge: the entry shows `outcome.target`. Move: the entry shows `outcome.source`, or `outcome.target` when `source` is null. The entry is remounted for the concept it then shows, so it builds its state from the returned concept. The reason field is cleared by that remount.
18. **Screen: errors in a dialog.** A failed preview shows the server's message in place of the result and leaves confirm unavailable; for `duplicate_text` the dialog shows the mockup's sentence built from the catalog. A real run refused as `outdated` shows the mockup's sentence naming the concept with that `concept_id` and requests a new preview. Any other failure of the real run shows its message and keeps the dialog open.

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/services/terminology/model.py` | New actions and the transfer models (Reading 1). |
| `backend/app/services/terminology/rows.py` | Row helpers: move a term, insert/update/delete a section, find a term's concept. |
| `backend/app/services/terminology/changes.py` | `transfer_entries`: the log entries of Reading 12. |
| `backend/app/services/terminology/transfer.py` (new) | `plan_transfer`: pure decision of what happens to each term, definition and domain; no database access. |
| `backend/app/services/terminology/store.py` | `_transfer`, `merge_concept`, `move_term`, preview by rollback. |
| `backend/app/api/terminology.py` | The two endpoints. |
| `backend/tests/test_terminology_transfer.py` (new) | Store tests. |
| `backend/tests/test_terminology_transfer_api.py` (new) | API tests. |
| `backend/tests/test_terminology_concurrency.py` | One raced pair. |
| `frontend/src/types.ts`, `frontend/src/api/client.ts` | `TransferOutcome` types; `mergeConcept`, `moveTerm`. |
| `frontend/src/terminology/transfer.ts` (new) | Pure functions: suggestions, highlight parts, result rows, notices. |
| `frontend/src/terminology/TargetPicker.tsx` (new) | Search field with suggestion list; picked state with "Change". |
| `frontend/src/terminology/useTransferPreview.ts` (new) | Requests previews; only the latest answer counts. |
| `frontend/src/terminology/MergeDialog.tsx`, `MoveDialog.tsx` (new) | The two dialogs. |
| `frontend/src/terminology/ConceptEntry.tsx`, `LanguageSectionEditor.tsx`, `TerminologyView.tsx` | The two buttons, opening the dialogs, what the entry shows afterwards. |
| `frontend/src/i18n/*`, `frontend/src/App.css` | Texts and styles. |

---

### Task 1: Decide and apply a move of one term to an existing concept

**Files:**
- Create: `backend/app/services/terminology/transfer.py`, `backend/tests/test_terminology_transfer.py`
- Modify: `backend/app/services/terminology/model.py`, `rows.py`, `changes.py`, `store.py`

**Interfaces:**
- Consumes: `rows.load_concept`, `_lock`, `require_writable`, `is_visible`, `rows.domain_names`, `changes.write`.
- Produces:
  - Models of Reading 1. `MovedTerm{id, text, language, usage_before, usage_after}`, `DroppedTerm{text, language, usage_status}`, `DroppedDefinition{language, definition}`, `DomainRef{id, name}`, `TransferOutcome{target: Concept, source: Concept | None, moved, dropped_terms, dropped_definitions, removed_languages: list[Language], dropped_domains, added_domains, basis: TransferBasis}`.
  - `transfer.basis_of(concept: Concept) -> ConceptBasis`.
  - `transfer.plan_transfer(source: Concept, term_ids: list[int], target: Concept | None, *, merge: bool) -> TransferPlan`, a frozen dataclass: `moves: list[PlannedMove]` (`term`, `language`, `usage_after`), `dropped: list[ConceptTerm with language]`, `removed_sections: list[LanguageSection]`, `adopted_definitions: dict[Language, str]`, `dropped_definitions: list[DroppedDefinition]`, `source_deleted: bool`. Raises `TerminologyRuleError("duplicate_text", …)` for a move onto an existing wording.
  - `TerminologyStore.move_term(term_id: int, target_id: int | None, *, basis: TransferBasis | None, preview: bool = False, actor: Actor, comment: str = "") -> TransferOutcome | None`. In this task `target_id=None` raises `NotImplementedError`.
  - `changes.transfer_entries(...) -> list[Entry]` (Reading 12; signature left to the implementer, used only by `_transfer`).

- [ ] **Step 1: Write failing tests for `plan_transfer`** in `test_terminology_transfer.py`, built on in-memory `Concept` objects (a small local factory), one test per rule:
  - `test_term_keeps_its_usage_status_when_the_target_has_no_active_preferred`
  - `test_active_preferred_becomes_admitted_next_to_an_active_preferred` (and the target's term is absent from `moves`)
  - `test_candidate_preferred_is_not_demoted` and `test_preferred_stays_next_to_a_candidate_preferred`
  - `test_move_onto_the_same_wording_is_refused` (`duplicate_text`)
  - `test_wording_that_differs_only_in_case_is_not_a_duplicate` ("Workspace" next to "workspace": moved, kept)
  - `test_last_term_of_a_language_removes_the_section`, `test_last_term_of_the_concept_deletes_it`
  - `test_definition_of_a_removed_section_is_adopted_by_a_target_without_one` (target section missing; target definition `"  "`)
  - `test_definition_of_a_removed_section_is_dropped_when_the_target_has_one`
  - `test_definition_stays_with_a_section_that_keeps_a_term`
- [ ] **Step 2:** Run `rtk proxy uv run pytest -q tests/test_terminology_transfer.py`; expect failures on the missing module.
- [ ] **Step 3:** Add the models and implement `basis_of` and `plan_transfer`. Wording is compared before the preferred rule (spec 4.2).
- [ ] **Step 4:** Run the file; expect green.
- [ ] **Step 5: Write failing store tests** (fixture: a `TerminologyStore` on the suite's database fixture, as `test_terminology_store.py` builds it, so they run on both databases):
  - `test_moved_term_keeps_id_uid_and_fields`
  - `test_version_numbers_after_a_move` (Reading 6: receiving section +1, losing section +1, moved term +1; a move that creates a target section and removes a source section raises both concepts by exactly 1)
  - `test_outcome_reports_moves_definitions_languages_and_domains` (Readings 8 to 10, with a source in two domains and a target in two, one shared)
  - `test_real_run_needs_the_basis_of_the_preview` (basis taken from a preview, then the target is saved through `save_concept`; the run raises `outdated` with the target's id and writes nothing: both concepts and the row count of `terminology_changes` are unchanged)
  - `test_outdated_names_the_source_first`
  - `test_preview_writes_nothing_and_matches_the_real_run` (preview, compare the two concepts and the change-log count with before; then the real run with the preview's basis returns an outcome equal to the preview's in every field)
  - `test_same_concept_and_other_owner_are_refused` (`same_concept`; `owner_mismatch` with a global target and an own source, as admin)
  - `test_invisible_or_foreign_term_is_not_found` (returns `None`: another user's concept as source or target; a term id that does not exist)
  - `test_non_admin_cannot_move_between_global_concepts` (`GlobalReadOnlyError`, for a preview too)
  - `test_change_log_of_a_move` (Reading 12: one batch; one `moved` entry on the target with the `concept` change and, when demoted, `usage_status`; `edited` entries for an adopted and for a dropped definition; a `deleted` concept entry without term entries when the source is emptied; the comment on every entry)
- [ ] **Step 6:** Run; expect failures.
- [ ] **Step 7:** Implement the row helpers, `changes.transfer_entries`, `_transfer` and `move_term`. `_transfer` follows Reading 4, applies the plan with the row helpers, raises version numbers per Reading 6 (use `rows.touch_concept` for the concept level), writes the log, and returns the outcome from freshly loaded concepts. A preview raises a private exception carrying the outcome inside the `with self._connect()` block, which rolls the transaction back, and `move_term` catches it outside the block.
- [ ] **Step 8:** Backend gate on both databases.
- [ ] **Step 9:** Mutation-verify: the demotion, the wording comparison, the basis comparison, the rollback of a preview (make the preview commit and watch `test_preview_writes_nothing…` fail), the `moved` action.
- [ ] **Step 10:** Commit: `feat(terminology): move a term to another concept`.

### Task 2: Merge, and a new concept as target

**Files:**
- Modify: `backend/app/services/terminology/transfer.py`, `changes.py`, `store.py`, `backend/tests/test_terminology_transfer.py`, `backend/tests/test_terminology_concurrency.py`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `TerminologyStore.merge_concept(source_id: int, target_id: int, *, basis: TransferBasis | None, preview: bool = False, actor: Actor, comment: str = "") -> TransferOutcome | None`.
  - `move_term(..., target_id=None, ...)` creates a concept with the source's owner and domain links.

- [ ] **Step 1: Failing tests.**
  - `plan_transfer(merge=True)`: `test_merge_drops_an_incoming_duplicate_and_keeps_the_target_term` (target's term untouched; the dropped one in `dropped` with its language), `test_merge_drops_a_preferred_duplicate_without_promoting_the_target_term`, `test_merge_moves_every_term_and_deletes_the_source`.
  - Store: `test_merge_outcome` (the "everything at once" case of the mockup's section 3: three languages, one duplicate, one adopted and one dropped definition, one dropped and one added domain; assert every field of the outcome and that the source is gone); `test_merge_raises_the_target_concept_by_one_for_several_new_languages`; `test_change_log_of_a_merge` (Reading 12: `merged` entry with `merged_into` first, `deleted` for the duplicate, `moved` for the others, nothing else for moved terms); `test_merge_preview_writes_nothing_and_matches_the_real_run`.
  - Store, new concept: `test_move_to_a_new_concept` (owner and domain links of the source; the term keeps `id`, `uid` and its usage status, also when it is preferred; the new section starts at 1; the definition is adopted only when the source section was removed; `added_domains` and `dropped_domains` empty; `basis.target` is `None`); `test_change_log_of_a_split` (`created` concept entry without term entries, one `moved` entry); `test_preview_of_a_new_concept_leaves_no_concept` (the count of concepts is unchanged).
  - Concurrency, in `test_terminology_concurrency.py`, with OS processes as the existing tests there do: `test_two_merges_of_the_same_pair_in_opposite_directions` (A into B and B into A at once, each with a basis read before: exactly one succeeds, the other gets `outdated` or `None`, neither deadlocks within the test's timeout, and one concept with all terms remains).
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement. For a new concept `_transfer` locks the source's domain rows before the concept rows, as `create_concept` does, and inserts the concept with `rows.insert_concept` and `rows.set_links`.
- [ ] **Step 4:** Backend gate on both databases.
- [ ] **Step 5:** Mutation-verify: dropping instead of refusing in a merge, the `merged` action, the domain links of a new concept, and the lock order (lock in the order given instead of ascending and watch the concurrency test fail on Postgres; state in the report if it cannot be made to fail and why).
- [ ] **Step 6:** Commit: `feat(terminology): merge concepts and split a term off`.

### Task 3: Endpoints

**Files:**
- Modify: `backend/app/api/terminology.py`
- Create: `backend/tests/test_terminology_transfer_api.py`

**Interfaces:**
- Consumes: `merge_concept`, `move_term`, `_concept_errors`, `_actor`, `features_for`.
- Produces:
  - `POST /api/concepts/{concept_id}/merge`, body `{target_id: int, preview: bool = false, basis: TransferBasis | null = null, comment: str = ""}`.
  - `POST /api/terms/{term_id}/move`, body the same with `target_id: int | null`.
  - Both answer 200 with `TransferOutcome` as it serialises (concepts without `owner_id`, with `is_global`).

- [ ] **Step 1: Failing tests** with the helpers of `terminology_helpers.py`:
  - `test_merge_preview_then_run` and `test_move_preview_then_run` (preview 200 and nothing changed; run with the returned basis 200; the list of the domain shows the result)
  - `test_run_without_basis_is_422`
  - `test_outdated_basis_is_409_with_the_concept_id` (`detail == {"code": "outdated", "message": …, "concept_id": …}`)
  - `test_rule_errors_are_409_objects` (`same_concept`, `owner_mismatch`, `duplicate_text`)
  - `test_unknown_or_foreign_ids_are_404` (source, target, term; for a second user's rows)
  - `test_non_admin_gets_403_on_global_concepts` (preview and run)
  - `test_new_concept_needs_the_feature` (tier without `custom_domains`: 403 for preview and run; a move to an existing concept still works)
  - `test_comment_reaches_the_change_log`
- [ ] **Step 2:** Run; expect 404s for the missing routes.
- [ ] **Step 3:** Implement both routes. The `outdated` error adds `concept_id` to the detail; extend `_concept_errors` or the error class so that this is the only special case.
- [ ] **Step 4:** Backend gate on both databases.
- [ ] **Step 5:** Mutation-verify the basis requirement and the feature gate.
- [ ] **Step 6:** Commit: `feat(api): merge and move endpoints`.

### Task 4: Types, client and the dialogs' logic

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`
- Create: `frontend/src/terminology/transfer.ts`, `frontend/src/terminology/transfer.test.ts`

**Interfaces:**
- Consumes: `conceptLabel`, `otherWordings`, `conceptLanguages`, `matchesQuery`, `sortByLabel` from `labels.ts`.
- Produces:
  - Types `TransferBasis`, `MovedTerm`, `DroppedTerm`, `DroppedDefinition`, `DomainRef`, `TransferOutcome` mirroring Task 3's JSON.
  - `mergeConcept(sourceId: number, body: {target_id: number; preview?: boolean; basis?: TransferBasis; comment?: string}): Promise<TransferOutcome>`, `moveTerm(termId: number, body: {target_id: number | null; …same}): Promise<TransferOutcome>`.
  - `HttpError` gains `conceptId?: number`, read from the 409 detail like `part`.
  - `suggest(candidates: Concept[], query: string, language: Language, order: Language[]): Concept[]` (Reading 16).
  - `highlight(text: string, query: string): {text: string; match: boolean}[]` (every case-insensitive occurrence; one part with `match: false` for an empty query).
  - `resultRows(outcome: TransferOutcome, order: Language[]): {language: Language; terms: {term: ConceptTerm; incoming: boolean}[]; demoted: string[]}[]`: the target's sections in `conceptLanguages` order; `incoming` for ids in `outcome.moved`; `demoted` the wordings whose usage changed from preferred to admitted.
  - `notices(outcome: TransferOutcome, kind: 'merge' | 'move'): Notice[]` where `Notice` is a tagged union: `{kind: 'droppedTerm', text, language, usageStatus}`, `{kind: 'droppedDefinition', language, definition}`, `{kind: 'droppedDomain', name}`, `{kind: 'addedDomain', name}`, `{kind: 'demoted', text}`, `{kind: 'lostLanguage', language, definition: string | null}`, `{kind: 'sourceDeleted'}`. For `'merge'`: dropped terms, dropped definitions, dropped domains, in that order (added domains and demotions are shown elsewhere in that dialog and are returned by `resultRows` and `outcome.added_domains`). For `'move'`: demoted, lost language (with the dropped definition of that language, if any), dropped domain, added domain, source deleted, in that order.

- [ ] **Step 1: Failing tests** in `transfer.test.ts`, with outcome fixtures written as literals:
  - `suggest`: prefix matches before other matches; both groups alphabetical; a match only in another language is found; empty query returns all in label order; the label in the fallback language decides the prefix group for a concept without a term in the list language.
  - `highlight`: several occurrences, case-insensitive, original casing kept, no match, empty query.
  - `resultRows`: language order, incoming flags, demoted wordings, a language that only exists through incoming terms.
  - `notices`: each kind for merge and for move, the two orders, and an outcome with nothing to report gives `[]` for both.
  - client: `mergeConcept` and `moveTerm` send the body to the right URL (as the neighbouring client tests do); a 409 with `concept_id` sets `HttpError.conceptId`.
- [ ] **Step 2:** `rtk proxy npx vitest run src/terminology/transfer.test.ts`; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the prefix-first order and the notice order.
- [ ] **Step 6:** Commit: `feat(terminology): client and logic for merge and move`.

### Task 5: Target picker, preview hook and the merge dialog

**Files:**
- Create: `frontend/src/terminology/TargetPicker.tsx`, `useTransferPreview.ts`, `MergeDialog.tsx`, `MergeDialog.test.tsx`
- Modify: `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`

**Interfaces:**
- Consumes: Task 4; `ui/Dialog`; `StatusChip`; `useMessages`; `languageName`.
- Produces:
  - `<TargetPicker candidates language order target onPick(concept | null) disabled />`: without a target, a text field (placeholder `searchConceptsPlaceholder`, accessible name the mockup's "Into") and the suggestion list as a listbox, rows as in the mockup's section 2 (label with fallback language marker, other wordings joined by " · " with highlights, language markers); arrow keys move the active row, Enter picks it. With a target, the label and a "Change" link button that calls `onPick(null)` and returns focus to the field.
  - `useTransferPreview(run: (() => Promise<TransferOutcome>) | null): {outcome: TransferOutcome | null; loading: boolean; error: HttpError | null; reload: () => void}`. A new `run` (or `reload`) starts a request and clears the previous outcome; an answer is applied only if it belongs to the latest request and the component is mounted.
  - `<MergeDialog source candidates language order comment onDone(outcome: TransferOutcome) onClose />`.
- The dialog's states are the mockup's sections 2 to 4: picking; waiting ("Working out the result…", confirm unavailable); result (rows from `resultRows`, the demotion lines, the box "Not taken over" only with notices, the added-domains line only with added domains); out of date (Reading 18). Confirm calls `mergeConcept` with `outcome.basis` and the comment, is unavailable while that request runs, and then calls `onDone`.

- [ ] **Step 1: Failing tests** in `MergeDialog.test.tsx` (client functions mocked as in `ConceptEntry.test.tsx`):
  - lists all candidates on opening and narrows and reorders them while typing
  - picking by click and by keyboard requests a preview for that target
  - shows the waiting text and keeps confirm unavailable until the preview answers
  - renders the result of the "everything at once" outcome: chips per language, the "+" mark with its accessible name on incoming terms only, both demotion lines, three notices, the added-domain line
  - renders no box and no added-domain line for the simple outcome
  - a late answer for an earlier target does not replace the preview of the later one (two controlled promises, resolved in reverse order)
  - "Change" clears the result and returns to the field
  - confirm sends the basis on display and the comment, then calls `onDone` with the answer; a second click while it runs sends nothing
  - an `outdated` refusal shows the sentence with the changed concept's label and a fresh preview, and confirm then sends the new basis
  - a failed preview shows its message and keeps confirm unavailable
  - closing while a preview is pending causes no state update afterwards (no act warning)
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement components, texts (all seven catalogs) and styles. Open the mockup and match section 2, 3 and 4.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the latest-request rule, the disabled confirm during a run, and the hidden box for an empty notice list.
- [ ] **Step 6:** Commit: `feat(terminology): merge dialog`.

### Task 6: The move dialog

**Files:**
- Create: `frontend/src/terminology/MoveDialog.tsx`, `MoveDialog.test.tsx`
- Modify: `frontend/src/i18n/messages.ts` and the seven catalogs, `frontend/src/App.css`

**Interfaces:**
- Consumes: `TargetPicker`, `useTransferPreview`, `notices`, `moveTerm`.
- Produces: `<MoveDialog source term candidates language order comment canCreate onDone(outcome) onClose />`. `canCreate` false hides "To a new concept" (Reading 13).
- States are the mockup's section 5. "To the concept" is selected on opening. A preview is requested when a target is picked or "To a new concept" is chosen. The box "This also happens" appears only with notices. For a new concept the line "The new concept is in the same domains as …" is shown. The confirm button is "Move", or red "Move and delete …" when `outcome.source` is null.

- [ ] **Step 1: Failing tests** in `MoveDialog.test.tsx`:
  - no box for a move without side effects
  - each notice kind renders its sentence; the lost language carries the dropped definition
  - red confirm naming the concept when the source is deleted, plain "Move" otherwise
  - choosing "To a new concept" requests a preview with `target_id: null` and shows the domains line; the option is absent without `canCreate`
  - a `duplicate_text` refusal of the preview shows the mockup's sentence with target label, wording and language name, and "Move" is unavailable
  - switching between the two choices keeps a picked target and requests the matching preview
  - confirm sends the basis and the comment and calls `onDone`
  - an `outdated` refusal shows the sentence and a fresh preview
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement, with texts and styles, matching the mockup's section 5.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the red-button condition and the `canCreate` gate.
- [ ] **Step 6:** Commit: `feat(terminology): move dialog`.

### Task 7: The two buttons and what the entry shows afterwards

**Files:**
- Modify: `frontend/src/terminology/ConceptEntry.tsx`, `LanguageSectionEditor.tsx`, `TerminologyView.tsx`, their test files, `frontend/src/i18n/*`, `frontend/src/App.css`

**Interfaces:**
- Consumes: `MergeDialog`, `MoveDialog`.
- Produces:
  - `ConceptEntry` props: `candidates: Concept[]`, `canCreate: boolean`, `onTransferred(outcome: TransferOutcome, kind: 'merge' | 'move'): void`. It renders "Merge into…" before "Remove from this domain" and opens the dialogs (Reading 14), passing its `comment`.
  - `LanguageSectionEditor` props: `onMoveTerm?: (termId: number) => void`, `moveBlocked: boolean`; "Move…" at the end of a term's details, as in the mockup's section 1.
  - `TerminologyView`: passes the candidates (Reading 15) and `canCreate`; on `onTransferred` reloads the concepts of the active domain and shows the entry of Reading 17, using `showEntry` so that `openRef` stays in step; the entry element gets a `key` that changes with the concept shown and with each transfer.

- [ ] **Step 1: Failing tests.**
  - `ConceptEntry.test.tsx`: both buttons absent for a new concept and for a read-only one; disabled with unsaved changes and while a save runs; "Merge into…" disabled without candidates; "Move…" absent for a term without an id; a typed reason alone leaves them enabled and reaches the dialog's request as `comment`; the dialogs open and close; `onTransferred` is called with the outcome and the kind.
  - `TerminologyView.ownership.test.tsx`: after a merge the list is reloaded and the entry shows the target; after a move the entry shows the source with the term gone and an empty reason field; after a move that deletes the source the entry shows the target; the candidates exclude the open concept; an answer that arrives after the writer went back to the list reloads the list and opens nothing.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Frontend gate.
- [ ] **Step 5:** Mutation-verify the unsaved guard on both buttons, the entry shown after a move, and the late-answer case.
- [ ] **Step 6:** Commit: `feat(terminology): merge and move from the concept entry`.

### Task 8: Documentation

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `docs/architecture-atlas/atlas-data.js`, `README.md`

- [ ] **Step 1:** Backend architecture: the two endpoints in the endpoint table, the transfer operation (one function, preview by rollback, basis, lock order), the two new log actions.
- [ ] **Step 2:** Frontend architecture: `transfer.ts`, the two dialogs, the preview hook under "Answers that arrive late", what the entry shows afterwards.
- [ ] **Step 3:** Atlas: add the new modules where the terminology modules are listed; run the atlas check the file's header names.
- [ ] **Step 4:** README: one or two sentences in the terminology section on merging, moving and splitting.
- [ ] **Step 5:** Backend gate (SQLite is enough here) and frontend gate; commit: `docs: merging concepts and moving terms`.

## Review Focus

Failure modes the spec implies but states no test for; each has its test in the task named.

1. **A wording that differs only in case** from a target term is moved and kept, not treated as a duplicate (Task 1, `test_wording_that_differs_only_in_case_is_not_a_duplicate`).
2. **Two merges of the same pair in opposite directions** end with one concept, no deadlock and no lost term (Task 2, concurrency test).
3. **A late preview answer** for a target the writer has already replaced must not be shown or confirmed (Task 5).
4. **A double click on confirm** sends one request (Task 5).
5. **A typed reason without other edits** must not block the actions, must reach the log, and must be gone afterwards (Task 7).

## Execution Plan

Sequential, one agent at a time. Implementers on the mid tier; the reviews of the store work (R1) and the final review on the most capable model.

| Step | What | Review |
|---|---|---|
| Tasks 1 to 3 | Store and API | **R1** after Task 3: spec 4 and 5, Readings 1 to 13 |
| Tasks 4 to 7 | Client, dialogs, wiring | **R2** after Task 7: spec 6, Readings 14 to 18, the mockup side by side with the rendered dialogs |
| Trial | In the browser, by the controller, on its own scratch stack (own `config.yaml` with a scratch SQLite file, ports other than 5173 and 8000, placeholder provider keys): merge two single-term concepts; the "everything at once" merge; a move with and without side effects; a split; a refused move; an out-of-date merge provoked from a second browser context; a non-admin on a shared domain. Screenshots of each dialog state are compared with the mockup. | |
| Task 8 | Documentation | |
| Final review | Whole branch | Most capable model |

Delivery is one pull request.
