# Suggestion Vetting M2 Implementation Plan — Morphology-aware spelling

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hunspell-backed spell gate via spylls (spec M2 of `2026-07-04-suggestion-vetting-design.md`).

**Architecture (validated by probes 2026-07-04):** Union gate — a candidate word passes the spell gate if it is (a) in the document whitelist, (b) known to the language's Hunspell dictionary (when installed under `dictionaries_dir`), or (c) known to the pyspellchecker frequency list. igerman98 resolves German compounds productively (Basisversion, Softwareaktualisierung → known) and does NOT contain archaic empföhle/empfähle, so the M1 regression cases hold. Dictionaries are downloaded (not bundled — GPL et al. licenses) from wooorm/dictionaries; spylls 0.1.7 parses all five (en/de/fr/es/it) on Python 3.13, load 0.1–1s, cached lazily. Deviation from spec detail: a single `dictionaries_dir` with `<lang>.aff/.dic` convention instead of per-language path config.

### Task 1: install script + local install
- Create `backend/scripts/install-dictionaries.sh <lang>...` (curl from `https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/<lang>/index.{aff,dic}` → `backend/dictionaries/<lang>.{aff,dic}`); note licenses in script comment.
- Add `dictionaries/` to backend `.gitignore`; run script for en de fr es it.

### Task 2: hunspell layer in vetting (TDD)
- Config: `Settings.dictionaries_dir: Path = BACKEND_DIR / "dictionaries"`.
- Failing tests (skipif dictionary files absent): DE candidate with novel compound `Grundversion` (not in doc, not in frequency list) accepted when `dictionaries_dir` given — and rejected without it (M1 fallback documented); empföhle/recieve still rejected with dictionaries; EN inflection cases.
- Implement: `_hunspell(code, dictionaries_dir)` lazy cache keyed by (dir, lang); `_has_unknown_words` consults whitelist → hunspell → frequency; `vet_candidates`/`vet_suggestions` gain `dictionaries_dir: Path | None = None`.
- Wire: `suggestions.py` and `checks.py`/`LLMChecker` pass `settings.dictionaries_dir`.

### Task 3: false-reject benchmark
- `backend/scripts/vetting-benchmark.py`: for each demo text, vet every sentence as a candidate with an EMPTY whitelist; report per language how many words the frequency-only gate rejects vs. frequency+hunspell. Run and record output in the final report.

### Task 4: docs + E2E
- README: dictionaries install section + upgrade note; `config.example.yaml`: `dictionaries_dir`.
- Spec: mark M2 delivered with the union-gate/dir-convention notes.
- E2E: live DE suggest on the würde case with dictionaries installed (garbage still rejected); full suites; commit.
