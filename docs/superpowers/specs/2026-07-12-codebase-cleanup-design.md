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
