# Suggestion Vetting M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic vetting of LLM-generated suggestions (spec: `docs/superpowers/specs/2026-07-04-suggestion-vetting-design.md`, milestone M1).

**Architecture:** New `vetting.py` module with three stages (sanity, pyspellchecker gate with document whitelist, rule-engine before/after re-check). Wired into `/api/suggestions` (all stages, plus `rule_id` resolution requirement) and `LLMChecker` (stages 1–2). Prompts steer toward idiomatic fixes. `Settings.vet_suggestions` kill switch. Frontend explains empty vetted results.

**Tech Stack:** pyspellchecker 0.9.0 (already added), existing RuleEngine/NlpRegistry.

**Pre-verified:** DE dict: empföhle/empfähle unknown, empfehle known, Basisversion unknown (whitelist needed). EN: recieve unknown.

---

### Task 1: Vetting module — sanity + spell gate
Files: create `backend/app/checkers/llm/vetting.py`, test `backend/tests/test_vetting.py`.
- [ ] Failing tests: sanity (empty/identical/length-ratio/bracket artifacts rejected), spell gate DE regression case, whitelist (`Basisversion`), digits skipped, JA skipped, unknown-language skipped.
- [ ] Implement `_sane`, `_unknown_words(candidate, language, whitelist)`, lazy `_checker(language)` cache, `vet_candidates(candidates, *, original, text, language) -> VetResult(accepted, rejected)`.
- [ ] Full suite; commit.

### Task 2: Rule re-check stage
Files: `vetting.py`, `test_vetting.py`.
- [ ] Failing tests using the real rules dir + registry: candidate that still triggers the named rule → rejected; candidate introducing `grammar.repeated-words` → rejected; clean fix → accepted; works with `rule_id=None` (only "no new findings" applies).
- [ ] Implement `passes_rule_recheck(candidate, *, text, start, end, language, rule_id, engine, nlp) -> bool` (Counter comparison per spec) and `vet_suggestions(...)` combining all stages.
- [ ] Full suite; commit.

### Task 3: Prompt adjustments
Files: `prompts.py`, `test_llm_checker.py`.
- [ ] Failing test: suggestion+rewrite system prompts contain the idiomatic-fix instruction ("not a transformation recipe" wording).
- [ ] Add the rule to both templates; full suite; commit.

### Task 4: Wire into /api/suggestions + config flag
Files: `suggestions.py`, `config.py` (`vet_suggestions: bool = True`), `test_suggestions_api.py`.
- [ ] Failing tests (FakeProvider): poisoned DE candidates → 200, empty suggestions, `rejected == 2`; good candidate passes; `rule_id` in request enforced (fix not fixing → rejected); `vet_suggestions=False` returns raw.
- [ ] Implement: request field `rule_id`, response field `rejected`, vetting call with `app.state.rule_engine` / `app.state.nlp` / settings flag.
- [ ] Full suite; commit.

### Task 5: Inline suggestion vetting in LLMChecker
Files: `checker.py`, `checks.py` (pass flag), `test_llm_checker.py`.
- [ ] Failing test: FakeProvider finding with suggestions `["recieve better", "receive better"]` on EN text → finding survives with only the clean suggestion.
- [ ] Implement: `LLMChecker(provider, vet=True)`; stages 1–2 per finding after anchoring.
- [ ] Full suite; commit.

### Task 6: Frontend messaging
Files: `frontend/src/checking/suggest.ts`, `state/store.ts` (if needed), `sidebar/Sidebar.tsx`, `api/client.ts` (types: `rejected`, request `rule_id`), test `suggest.test.ts` or extend existing.
- [ ] Failing vitest: helper mapping `{suggestions: [], rejected: n}` → message "No reliable suggestion — n candidate(s) failed local checks."
- [ ] Implement: pass finding.rule_id in requests; on empty+rejected set the suggest/rewrite error to that message.
- [ ] `npm test && npm run build`; commit.

### Task 7: Docs + E2E
- [ ] README section under LLM checking; `config.example.yaml` `vet_suggestions` entry.
- [ ] E2E: servers up; `/api/suggestions` with FakeProvider not available live — instead use ollama live suggest on DE würde sentence and observe vetting fields; screenshot regression covered by unit tests. Full suites; commit.
