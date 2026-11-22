# Terminology management roadmap

Date: 2026-11-22. Umbrella issue: #150. Background and sources:
[`docs/notes/2026-08-24-terminology-management-research.md`](notes/2026-08-24-terminology-management-research.md).

## Direction

Grow the terminology component from a word-list checker into a termbase
whose entries are enforced by the checker. Individual writers are served
first. The design must not block a later extension to organisations
(shared termbases, approval, custom attributes), but none of that is built
until there is demand.

Each milestone goes through its own spec, plan and PR, and is tracked as a
sub-issue of #150. This document fixes the order and the decisions that
span milestones; the specs settle everything else.

## Milestones

| # | Milestone | Issue | Result for the writer |
|---|---|---|---|
| T1 | Concept and status model | #205 | Warnings as well as errors; one entry per concept across languages |
| T2 | Morphology-aware matching | #206 | Plurals, inflected forms and German compounds are caught |
| T3 | Term extraction | #207 | A termbase can be built from the writer's own texts |
| T4 | Import and export | #208 | An existing term list can be brought in and taken out |
| T5 | Governance and organisations | #209 | History view; later shared termbases with review |

T1 is the prerequisite for T3, T4 and T5. T2 touches only the checker and
could run before or alongside T1 if that is convenient.

### T1 — Concept and status model

1. **Schema and migration.** Introduce a concept above the term. Every
   variant becomes a term row of its own under a concept and language,
   with a usage status. Existing terms and their `forbidden_variants` are
   migrated; the API and the UI stay unchanged in this step. Both storage
   backends (SQLite and Postgres) are covered.
2. **Statuses in the checker and the UI.** Preferred, admitted, deprecated
   and forbidden, with an optional reason per variant. Status maps to
   finding severity (forbidden to error, deprecated to warning, admitted
   to suggestion or no finding).
3. **Concept view and metadata.** One entry shows the terms of all
   languages for a concept. Add context (example sentence), source and
   part of speech.
4. **Change recording.** Created and modified, by whom and when, on every
   concept and term, plus an append-only change log written by the store
   on every add, edit and delete (old and new value, who, when, and the
   origin: manual entry, extraction or import). Log entries outlive the
   concept or term they describe. Existing terms get one "carried over"
   entry at migration. No UI in this milestone; the history view is T5.

To settle in the spec:

- The exact status list, re-verified against https://datcatinfo.net/ (the
  research note marks its own summary as unverified).
- Whether "candidate" is a status from the start. T3 and T5 both need a
  state for terms that exist but are not yet enforced.
- What happens to change-log entries when the user who made the change
  is deleted.

### T2 — Morphology-aware matching

1. **Lemma matching**, opt-in per term, for English, German, French,
   Spanish and Italian, using the tagger and lemmatizer of the spaCy
   pipelines that are already loaded.
2. **German compounds** via CharSplit (one new dependency; licence check
   required).
3. **Performance.** The checker currently runs tokenization only. Measure
   check latency and test-suite runtime before and after, and decide
   whether the fuller pipeline runs only when a domain contains opt-in
   terms.

### T3 — Term extraction

1. **Spike.** Measure precision and cost per document of LLM-based
   extraction on a real corpus. The research note did not benchmark this;
   the result decides whether the milestone proceeds as planned.
2. **"Suggest terms from this document."** Produces candidate terms with
   drafted definitions, reusing `backend/app/checkers/llm/`. The writer
   accepts, edits or discards each candidate. Usage counts against the
   existing credit budget.

### T4 — Import and export

1. **Own JSON format, basic flavour**, in both directions: one domain
   with its concepts and terms, for use by other tools and scripts.
2. **Own JSON format, extended flavour**, in both directions: a complete
   dump for backup and for moving terminology to another installation.
   It adds everything the basic flavour leaves out: the full change log,
   links between concepts and domains, and later the definitions of
   custom attributes with their pick-lists.
3. **CSV** in both directions, for spreadsheets.
4. **TBX-Basic export.**
5. **TBX-Basic import**, with a round-trip test (export, import, compare).
   Fields the model cannot hold are skipped and listed in an import
   report, not stored speculatively.

The two JSON flavours are one format: the basic flavour is a subset of the
extended one, with the same field names, one version number in the file
and a published JSON Schema. The extended flavour must round-trip without
loss (export, import into an empty installation, export again, compare).
TBX is not extended with private additions; a private dialect would be
readable by no other tool.

To settle in the spec:

- How the change log's user references are carried between installations
  whose accounts differ, including the privacy side.
- Restore into an empty installation versus merge into existing data.
  Globally unique identifiers on concepts and terms let the importer
  recognise an entry it has seen before.

### T5 — Governance and organisations

1. **History view** over the change log recorded since T1, and a "not
   reviewed since" flag. Neither needs shared ownership.
2. **Shared termbases.** Domains are currently global or owned by one
   user; there is no team or organisation. This is a project of its own
   and the prerequisite for the next two items.
3. **Proposal and approval**, with an approver role distinct from
   ownership, behind a feature gate.
4. **Custom attributes** (free text or pick-list, defined per termbase).

## Decisions that span milestones

- **Every variant is a row with its own identifier.** Statuses, reasons
  and later custom attributes attach to the concept, the language section
  or the individual term. This is also the structure of TBX. It is the
  one condition T1 must meet for custom attributes to be a purely
  additive change later.
- **Changes are recorded from T1 on.** History cannot be reconstructed
  afterwards, so the change log is written from the first milestone even
  though it is only displayed in T5. Extraction (T3) and import (T4)
  write to the same log with their own origin.
- **Built-in fields are real columns.** Definition, context, source and
  part of speech are not put in a generic key-value store.
- **Custom attributes never affect checking.** They are descriptive data.
- **Ownership checks stay in one place** (`backend/app/services/ownership.py`),
  so that "owner" can later mean an organisation.
- **Inflection matching is opt-in per term**, not a global switch.
- **TBX support is only claimed once the round trip is tested.** The
  research note documents tools whose TBX output does not re-import
  cleanly.

## Deferred

- Labelled cross-references between concepts (see also, antonym,
  hypernym, and relation types a user defines). Additive later: a relation
  table of its own (source, target, type) plus a small table for
  user-defined types, relying only on the stable concept and term
  identifiers from T1. Relations never affect checking. Points for that
  spec: symmetric versus directed relations with an inverse, and what
  happens to links when a concept is deleted or merged. TBX-Basic can
  only carry an untyped cross-reference (at concept and term level), so
  labels are lost on export to it and absent on import from it.
- Subject fields from a controlled vocabulary instead of free-text domain
  names. Needs its own research spike.
- Finer-grained context rules (a term forbidden only near another term).
  The research found no established pattern for this.
