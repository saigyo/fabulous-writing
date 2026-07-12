# Codebase Cleanup Iteration — Design

**Date:** 2026-07-12
**Status:** Approved design, pending audit results for concrete scope

## Goal

A critical review of the entire codebase followed by targeted cleanup. **No new
features.** Browser-observable behavior stays identical and the owner's live
`backend/data/fabulous.db` data is preserved. The deliverable is a cleaner
codebase across four dimensions:

1. **Structure & boundaries** — oversized or tangled modules, unclear
   responsibilities, coupling between state/autosave/checking logic.
2. **Duplication & dead code** — repeated validation/CRUD patterns across
   routers and views, leftovers from superseded iterations, unused exports,
   i18n keys, CSS.
3. **Correctness hazards** — latent bugs and fragile patterns: race
   conditions, suppression-flag style state hacks, error-handling gaps.
4. **Test-suite quality** — tests that encode implementation details,
   redundant tests, coverage gaps on tricky logic.

## Freeze line

| Layer | Status |
| --- | --- |
| Browser-observable behavior | **Frozen** — identical before and after |
| Live DB data | **Preserved** — schema migrations allowed, data loss is not |
| HTTP API shape | May change, in lockstep with the frontend |
| DB schema | May change via migration |
| Internal module layout | May change freely |
| Rule YAML / config file formats | Frozen (user-editable surfaces) |

If fixing a finding properly would require a behavior change, the finding is
escalated to the owner instead of silently shipped.

## Process

Audit → triage → plan → execute. No code changes before triage completes.

### Phase 0 — Behavioral baseline

Establish the "identical functionality" yardstick before any change:

- Confirm both suites green (currently 696 backend / 230 frontend tests).
- Turn the proven scratch-stack e2e smoke (see memory `scratch-e2e-recipe`)
  into a repeatable script covering the core flows: type → rule findings →
  apply suggestion; autosave round-trip; folders + per-folder defaults;
  profiles; terminology. Whether the script is committed under
  `frontend/scripts/` or stays session-scratch is a triage decision.
- The same script re-runs as the exit gate of the iteration.

The baseline never touches the live DB or the owner's dev servers
(:5173/:8000); it uses its own scratch backend and preview, and cleans up
after itself.

### Phase 1 — Audit wave

Five parallel **read-only** review subagents, one per slice, all with the same
rubric: find accretion, duplication, dead code, fragile state patterns, and
tests that assert implementation rather than behavior. Every finding carries
`file:line` evidence, a severity (Critical / Important / Minor), a concrete
proposed remedy, and a risk note.

| # | Slice | Contents |
| --- | --- | --- |
| 1 | Backend services + API | `app/services/*`, `app/api/*`, `app/main.py`, `app/core/*` — store patterns, `_migrate` accretion, validation duplication, error handling |
| 2 | Backend checkers + LLM | `app/checkers/**` incl. providers, vetting, anchoring, prompts, rules engine, pipeline, `app/nlp/*` |
| 3 | Frontend core logic | `state/store.ts`, `documents/documents.ts`, `documents/autosave.ts`, `checking/*`, `api/client.ts` — the suppression-flag mechanics and state interplay |
| 4 | Frontend views + assets | components/views, `i18n/*`, CSS — oversized components, repeated CRUD-view patterns, dead keys/styles |
| 5 | Test suites | `backend/tests/**` and `frontend/src/**/*.test.*` — redundancy, implementation coupling, gaps on tricky logic |

Findings land as files in `.superpowers/sdd/audit/<slice>.md`. The recorded
keep-accepted minors from past reviews (in `.superpowers/sdd/progress.md`,
e.g. the defaults-dialog 404 folder refresh) are folded into the same pool.

### Phase 2 — Consolidated triage

The controller merges and de-duplicates all findings into one list, grouped by
theme and severity, each with a keep/drop recommendation. The owner triages;
**nothing is fixed without surviving this gate.** Judgment calls (e.g. whether
splitting a large file is worth the churn) are the owner's, made with the
evidence in front of them.

### Phase 3 — Spec addendum + plan + execution

Accepted findings become a concrete work-package list (appended to this spec
or a follow-up spec), then an implementation plan ordered to avoid
self-collision:

1. Dead-code deletion
2. De-duplication
3. Structural moves/splits
4. Test cleanup

Execution uses the established subagent-driven pipeline: fresh implementer per
task, task reviews, gates green per task (`uv run pytest -q` zero warnings;
`npx vitest run && npx tsc --noEmit && npm run lint && npm run build`), final
whole-branch review on fable, one push on main with CI report, LOGBOOK and
architecture docs updated.

## Risk handling

- Any schema migration is rehearsed against a **copy** of the live DB, never
  the live file.
- Refactors that rename e2e-relevant CSS classes update the baseline script in
  the same task.
- Findings whose remedy would change behavior are escalated, not shipped.
- The audit wave is read-only; no working-tree changes until Phase 3.

## Out of scope

- New features of any kind (including UX polish that changes behavior).
- Dependency upgrades (handled separately via dependabot).
- Performance optimization, unless a finding shows an outright defect.

---

## Addendum: Phase 2 triage outcome (2026-07-12)

Audit wave complete (5 slices; reports in `.superpowers/sdd/audit/`, consolidated
in `consolidated-triage.md` there). Owner triage decisions:

**Approved for the plan (work packages):**

- **A — Correctness:** A1 cancel in-flight check on document switch (Critical:
  scorecard leaks onto the next document and is autosaved); A2 folder
  rename/set-defaults responses must go through `_pruned()`; A3 harden the
  profile-apply suppression flag (error path never consumes it); A4 add backend
  logging at all swallow sites; A5 defaults-dialog 404-close refreshes folders;
  A6 reset the doc-menu "moving" submenu state on close; A7 folders.name
  UNIQUE COLLATE NOCASE migration (rehearse on a live-DB copy; escalate if the
  owner's data holds real case-duplicates).
- **B — Tests:** B1 controller.test.ts + suggest.test.ts (zero coverage on the
  supersession/veto logic); B2 anchoring boundary cases; B3 dedupe old-schema
  DDL fixtures. B4 decision: KEEP the no-component-test convention (pure-logic
  extraction + e2e baseline remain the .tsx safety net).
- **C — Structure:** C1 split documents.ts (folders / hydration / doc CRUD +
  init; suppression flag moves next to its consumer); C2 shared SQLite
  connect + migrate-columns helpers across the four stores; C3 shared
  request/streaming skeleton for the LLM providers; C4 extract pure helpers
  from DocumentSidebar.tsx / Sidebar.tsx (helpers only, no component split).
- **D — Dedup/dead code:** D1 shared `validate_name()` + backend non-empty
  check for term `preferred`; D2 delete always-true seeding conditionals;
  D3 merge the JSON-extractor twins; D4 remove dead `scheduler.checkNow()`;
  D5 single persist/migrate config object; D6 narrow `hydrateFromBuffer`'s
  synthetic document; D7 comment `RuleSpec.scope` as reserved; D9 shared
  provider env-key map. **D8 (Finding-constructor helper ×7 check types):
  dropped.**
- **E — Sanctioned behavior-visible fixes (owner-approved freeze deviations):**
  E1 shared CRUD-error hook incl. adding the missing error surface to
  TerminologyView; E2 unify menu dismissal on outside-click; E3 disable the
  defaults-dialog profile select during the post-language-change refetch.

All other ledger minors remain keep-accepted; audit clean areas are recorded
in the slice reports.
