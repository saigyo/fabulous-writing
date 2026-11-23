# Terminology T1: concept and status model

Date: 2026-11-22. Issue: #205 (part of #150). Roadmap:
[`docs/terminology-roadmap.md`](../../terminology-roadmap.md).
Screen mockup: [`2026-11-22-terminology-t1-concept-model-mockup.html`](2026-11-22-terminology-t1-concept-model-mockup.html).

## 1. Intent

Today a term is one preferred wording plus a flat list of forbidden
variants, in one language and one domain. Every finding is an error. Two
terms that mean the same thing in different languages are unrelated rows.

T1 replaces this with a termbase structure: a **concept** holds **terms**
grouped by language, each term has a usage status, and every change is
recorded. The writer gains warnings next to errors and one entry per
concept across languages. Term extraction (T3), import and export (T4) and
governance (T5) all build on this structure, which is why change recording
and shared concepts are part of T1: neither can be added afterwards without
loss or a second migration.

## 2. Goals, non-goals, anti-goals

**Goals**

- Concept, language section and term as separate rows with stable
  identifiers, on both storage backends.
- Usage status (preferred, admitted, deprecated, forbidden) and process
  status (candidate, active) on every term.
- Concepts can belong to several domains of the same owner.
- An append-only change log, written by the store.
- A save that would overwrite someone else's change is refused (5.7).
- Existing terms are migrated and are checked exactly as before.
- The checker maps status to severity and ignores candidates.
- A concept list and a concept entry screen as in the mockup.

**Non-goals** (each is deferred, not rejected)

- A history view and "not reviewed since" (T5, #209).
- Import and export in any format, including TBX-Basic (T4, #208). The
  mapping of "forbidden" to TBX-Basic is decided there.
- Per-domain status overrides on a shared concept (#209).
- A specified precedence between domains, including a defined order and
  an approval in one domain overruling a complaint in another (#211).
- More than one preferred term per concept and language.
- A checking option that flags admitted terms.
- Custom fields; subject fields; cross-references; the further TBX-Basic
  term fields (gender, term type, geographical usage, notes); a source for
  the definition.
- Inflection and compound matching (T2, #206).
- Merging of conflicting edits. A refused save keeps the edits on screen;
  the writer loads the current version and applies them again.

**Anti-goals**

- A change in what the checker reports for existing data after the
  migration.
- A change-log entry that is ever updated or deleted.
- A name stored on the concept.
- Built-in fields in a generic key-value store.

## 3. Constraints

- One schema definition serves SQLite and Postgres
  (`backend/app/services/db/`). Only SQL that both accept is used.
- With `manage_schema=false` the app only verifies the schema; creating
  and migrating happens through `init_stores()` (`backend/app/schema.py`).
- Ownership rules belong in `backend/app/services/ownership.py`. Today
  that file holds only the shared exception; the domain checks are inline
  in the store.
- Accounts are deactivated, never deleted (`backend/app/api/admin.py`), so
  a user reference in the log stays valid.
- User-facing text follows the informal register in all seven locales
  (`frontend/src/i18n/`, pinned by `register.test.ts`).

## 4. Approaches

1. **Three pull requests, each leaving the app working (chosen).** The
   first contains the tables, the migration, the store and the change log;
   the existing term endpoints remain as a translation layer over the new
   model, so the current screen keeps working. The second changes the
   checker. The third adds the concept endpoints and the new screen and
   removes the translation layer. The translation layer is throwaway work.
   In return the migration, which rewrites existing data, is reviewed and
   merged alone and each review stays readable.
2. **One pull request with everything.** No throwaway layer, but a very
   large review in which the data migration is one part among many, and
   nothing ships until all of it is done.
3. **Old and new tables side by side behind a switch.** Rejected: two
   sources of truth, and a change log with gaps for everything written to
   the old tables.

Chosen: approach 1, because smaller reviews carry less risk of a missed
defect.

## 5. Data model

### 5.1 Terms used in this document

| Word | Meaning |
|---|---|
| Concept | The language-independent meaning. Has no name. |
| Language section | The part of a concept that belongs to one language: its definition and its terms. |
| Term | One wording of a concept in one language. |
| Usage status | Whether a term should be used: preferred, admitted, deprecated, forbidden. |
| Process status | How far a term has been processed: candidate (not enforced) or active (enforced). |
| Domain | A term collection with an owner, as today. Not a subject field. |

### 5.2 Tables

`domains` is unchanged. The existing `terms` table is replaced; the new
term table has a different name so that both can exist during migration.
Identifier columns and timestamps follow the conventions of the other
stores (integer identity key; UTC ISO text timestamps).

**`concepts`**

| Column | Notes |
|---|---|
| `id` | Primary key. |
| `uid` | Globally unique identifier (UUID), unique, set at creation, never changed. |
| `owner_id` | Null means global, as for domains. |
| `revision` | Version number, see 5.7. |
| `created_at`, `created_by` | Nullable; null for rows carried over by the migration, where they are unknown. |
| `modified_at`, `modified_by` | Nullable; set when the concept's domain links or its set of languages change (5.7), not when a language section or a term changes. |

**`concept_domains`**: `concept_id`, `domain_id`, primary key on both.

**`concept_languages`** (the language section)

| Column | Notes |
|---|---|
| `id` | Primary key. |
| `concept_id` | |
| `language` | One of the existing `Language` values. Unique together with `concept_id`. |
| `definition` | Text, default empty. |
| `revision` | Version number, see 5.7. |
| `created_at`, `created_by`, `modified_at`, `modified_by` | As on the concept. |

**`concept_terms`**

| Column | Notes |
|---|---|
| `id` | Primary key. |
| `uid` | Globally unique identifier, as on the concept. |
| `section_id` | References `concept_languages`. |
| `text` | The wording, in its base form (section 5.6). Not empty. Unique within its section (exact match). |
| `usage_status` | `preferred`, `admitted`, `deprecated`, `forbidden`. |
| `process_status` | `candidate`, `active`. |
| `status_reason` | Text, default empty. Why the term has its usage status. |
| `context` | Text, default empty. An example sentence. |
| `source` | Text, default empty. Where the term comes from. |
| `part_of_speech` | Empty, or one of `noun`, `verb`, `adjective`, `adverb`, `proper_noun`, `other` (the TBX-Basic list). |
| `case_sensitive` | As today, but per term. |
| `revision` | Version number, see 5.7. |
| `created_at`, `created_by`, `modified_at`, `modified_by` | As on the concept. |

**`terminology_changes`** is described in section 7.

The pick-lists are validated by the store, not by database constraints, so
a later value needs no schema change. Each process status declares in code
whether it is enforced; the checker asks only that. A later value such as
"trial" is then one line.

### 5.3 Rules the store enforces

- A concept has at least one language section, and a language section has
  at least one term. Removing the last term of a section removes the
  section with its definition; removing the last section is refused (the
  concept must be deleted instead).
- A concept belongs to at least one domain.
- Among the **active** terms of a language section, at most one is
  preferred. This is a T1 rule that may be lifted later: nothing outside
  the store relies on it, and the label and suggestion logic in sections 6
  and 8 already work on a list.
- A language section may have terms and no preferred one.
- All writes of one save happen in one transaction.
- **Saves to the same concept are serialised by the database.** A save
  first writes to the concept row without changing it (an update that
  sets a column to its own value), which locks that row until commit on
  Postgres; only then does it read the concept's state and check these
  rules. The modified fields are set only when the save changes
  something, so a save without changes leaves no trace. SQLite
  serialises writers by itself. Two
  simultaneous saves can therefore not both pass a check that only one
  of them may pass. A save also locks the domain rows it names, before
  the concept row, so that a domain cannot be deleted while a concept is
  being linked to it.

### 5.4 Ownership and sharing

- A concept has its own `owner_id`. It can only be linked to domains with
  the same owner: own concepts to own domains, global concepts to global
  domains.
- Visibility and write permission follow the domain rule: visible to the
  owner, global rows visible to everyone and writable by admins only.
- The check that decides this is written once in `services/ownership.py`
  in the first pull request. The existing inline domain checks move to it,
  and concepts use it from the start.
- Creating a concept needs the `custom_domains` feature, as creating a
  term does today.
- **Removing a concept from a domain** deletes the link only. It is
  refused for the concept's last domain.
- **Deleting a concept** removes it from all domains, with its sections
  and terms.
- **Deleting a domain** removes its links; every concept that was in no
  other domain is deleted. Each of these is logged, in the same
  transaction as the domain deletion. `delete_domain` therefore takes the
  acting user like every other writing method.

### 5.5 Labels

A concept is shown by a derived label for the language the writer is
viewing. The first match wins:

1. the active preferred term in that language,
2. the first active admitted term in that language (alphabetical),
3. any other term in that language,
4. the same order in another language, languages taken in the fixed
   order of the `Language` enum, shown with a language marker.

The label is computed where it is displayed and is not stored.

### 5.6 Base form, and room for inflection later

Replacements suggested by the checker will later have to be inflected to
fit the sentence (T2 and after). T1 builds none of that, but two things
are fixed now so that it stays an additive change.

- **A term is stored in its base form:** nominative singular for a noun,
  infinitive for a verb, the uninflected dictionary form for an adjective.
  A wording that only exists in the plural, and a fixed phrase, are stored
  as they are. The entry screen says so next to the term field. Without
  this convention later generation of forms has no defined starting point.
- **An inflected form is never a term of its own.** It belongs to its
  term. Existing data may contain plurals that writers typed as separate
  forbidden variants; the migration cannot tell them apart and carries
  them over as terms.

Everything else attaches to the term row later without touching T1 data:
grammatical gender (a nullable column, as in TBX-Basic), the opt-in for
inflection matching from T2 (a column), and a table of explicit forms per
term for cases a generator gets wrong (irregular plurals, new or borrowed
words). `language` is a text column, so a finer value such as a script or
regional variant needs no schema change either.

### 5.7 Version numbers and simultaneous edits

Concept, language section and term each carry a version number
(`revision`). It starts at 1 and increases by 1 with every save that
changes that level:

| Level | Its number increases when |
|---|---|
| Term | one of its own fields changes |
| Language section | its definition changes, or a term in it is added, changed or removed |
| Concept | a domain link changes, or a language section is added or removed |

A level's `modified_at` and `modified_by` are set exactly when its number
increases. A change to a term therefore shows on the term and on its
language section, and not on the concept. "Last activity" on a concept is
the latest of the three levels and is computed where it is displayed.

A save states the numbers it read, and the store compares them after
locking (5.3) and before writing anything:

- For every language section the save writes or removes: the section's
  id and number. The id is part of the comparison because a language can
  be removed and added again, and the new section starts at 1 like the
  old one did; ids are never reused. For a language the concept does not
  have yet, the save states neither, and the language must still be
  absent.
- For the domain links, whenever a save sends them: the concept's number.

If one comparison fails, the whole save is refused and nothing is written.
Two people can therefore save different languages of one concept at the
same time, and add different languages at the same time. Two saves of the
same language, or of the domain links, conflict: the second is refused.
A save of the domain links is also refused when a language was added or
removed since it was read, because that increases the concept's number.

The term's number is maintained and returned. No operation in T1 checks
it, because every save writes a whole language section. A later operation
that writes a single term must check it, and must also increase the
section's number.

Deleting a concept, removing it from a domain and deleting a domain are
not checked: they do not write from a copy that may be out of date.

## 6. Migration

Runs once in the store's startup migration when the old `terms` table is
present. It is all or nothing: a failed run leaves the old table in place
and no new rows. If `terms` and `terms_legacy` both exist, startup stops
with an error instead of guessing. With `manage_schema=false` the app does
not migrate; schema verification fails with a pointer to `init-db` while
the old `terms` table is still present or a new table is missing.

For each old term row:

- one concept, with the owner of the term's domain, linked to that domain;
- one language section with the row's language and definition;
- one term with the row's preferred wording: `preferred`, `active`;
- one term per entry in `forbidden_variants`: `forbidden`, `active`;
- the language section takes the old row's id, so that the old
  endpoints keep addressing the same entry across the migration (a
  screen left open during the upgrade still holds the old ids). A
  section created later never takes an id the old table ever gave out,
  also not that of a row that was skipped or deleted before the upgrade;
- every new term takes the row's `case_sensitive` value;
- created and modified fields stay null on all three levels; every
  version number is 1;
- one "carried over" change-log entry for the concept and one for each
  term (section 7).

Duplicate entries in `forbidden_variants` and entries that are empty or
consist of whitespace only are skipped.

A variant that is exactly equal to the preferred wording is skipped, and
the migration logs a warning naming the domain and the wording. This is
the one deliberate exception to "checked exactly as before": such an
entry makes today's checker flag every occurrence of the preferred term
and suggest the same word as its replacement. A variant that differs only
in case is a different wording and is carried over.

A second exception: a row with an empty preferred wording, which the API
has not accepted for some time, is carried over as a language section
with its forbidden terms and no preferred term. Until the second and
third pull requests it produces no finding and is not listed on the old
screen; today it reports its variants with an empty suggestion. A row
that has neither a preferred wording nor a usable variant is skipped with
a warning. A row whose domain no longer exists is not carried over.

A row that cannot be converted, because its language is unknown or its
list of variants is not a list of texts, stops the migration with an
error that names the row and its domain. Nothing is migrated in that case.

On Postgres the migration locks the old table before it reads it, so that
a write by a still-running previous release cannot be lost between the
read and the rename. The previous release must be stopped before the
migration runs.

Afterwards the old table is renamed to `terms_legacy`. The store
migration of the third pull request drops it. *(Author's call: a rename costs nothing and keeps
the original data available until the new screen has shipped.)*

The import tool (`backend/app/manage_import.py`) migrates its source
file first, as it initialises the stores on it today, so a database from
before T1 still imports. Its table list gets the new tables, parents
first; `concept_domains` has no identity column; `terms_legacy` is not
copied.

Also to update: `REQUIRED_SCHEMA`, the seeding in
`backend/app/services/seed.py` (it creates concepts through the store, with
origin `seed`), and the schema tests. The Postgres application role gets
access to new tables through the existing default privileges; the
privilege test is extended to the new tables.

## 7. Change log

One table, `terminology_changes`, written only by the terminology store,
in the same transaction as the change.

| Column | Notes |
|---|---|
| `id` | Primary key. |
| `batch` | Identifier shared by all entries written by one save. |
| `at` | UTC timestamp. |
| `user_id` | Who. Null for migration and seeding. |
| `origin` | `manual`, `extraction`, `import`, `migration`, `seed`. |
| `action` | `created`, `edited`, `deleted`, `added_to_domain`, `removed_from_domain`, `carried_over`. |
| `concept_id`, `concept_uid` | The concept. |
| `term_id`, `term_uid` | The term, when the change is to a term; otherwise null. |
| `term_text`, `term_language` | Copy of the term's wording and language, for term entries. |
| `concept_labels` | JSON object with one label per language the concept has terms in (section 5.5, steps 1 to 3). |
| `changes` | JSON list of field changes: `{field, old, new}`, plus `language` for a definition. |
| `comment` | Optional reason, default empty. |

Rules:

- **Append-only.** No code path updates or deletes a row. The user
  reference is never rewritten, including for deactivated accounts.
- **No foreign keys to concepts or terms.** Entries outlive their subject.
- **Every entry can be displayed on its own.** The copied wording and
  labels are the state after the change, or the last state for a
  deletion. A history view shows a deleted term by its wording and a
  deleted concept by the label in the viewer's language, with the usual
  fallback to another language, without reconstructing anything from
  earlier entries.
- **One entry per changed subject per save.** Saving a concept entry that
  changes the concept and three of its terms writes four entries with the
  same `batch`. Several fields changed on one subject are one entry.
  *(Author's call, see section 11.)*
- A changed definition is logged on the concept, with its language.
- Usage status, process status and every other field of a term are logged
  on the term.
- `created` lists the initial values as new values. `deleted` lists the
  last state as old values. Deleting a concept writes an entry for the
  concept and one for each of its terms.
- Domain links are logged on the concept with the domain's id and name.
- `carried_over` lists the migrated state as new values, with origin
  `migration` and the migration time.
- A save that changes nothing writes nothing.

Every store method that writes takes the acting user, the origin and an
optional comment. There is no API or screen for reading the log in T1.

## 8. Checker

For a domain and a language, the checker loads the terms of the concepts
linked to that domain, in that language, whose process status is enforced.
Candidates are ignored completely: they produce no finding and are not
offered as replacements.

| Usage status of the matched term | Finding |
|---|---|
| forbidden | error |
| deprecated | warning |
| admitted | none |
| preferred | none |

- **Matching** is unchanged (word-bounded for Latin scripts, token or
  substring matching for Japanese and Chinese), using each term's own
  `case_sensitive`.
- **Casing findings** are unchanged in kind: a case-sensitive preferred or
  admitted term written in the wrong case is an error, with the existing
  sentence-start exception. The suggestion is the term's own text, also for
  an admitted term. A casing finding carries no status reason, because the
  reason explains a status, not a spelling. A text that equals an enforced
  preferred or admitted term of the same language section is not a casing
  finding, since two terms of a section may differ only in case. A text
  that any case-sensitive preferred or admitted term of the section accepts,
  sentence-start exception included, is not one either. Otherwise there is
  one casing finding per section and span, for the first such term, preferred
  terms before admitted ones.
- **Suggested replacements** come from the same language section: the
  active preferred term; if there is none, the active admitted terms; if
  there are none, the finding has no suggestion.
- **Message:** as today ("Use … instead of …"), followed by the status
  reason if there is one and the definition if there is one. With several
  replacements it reads "Use 'A' or 'B' instead of 'M'."; without one it
  reads "'M' is forbidden." or "'M' is deprecated.". `M` is the text as it
  stands in the document.
- **Rule id:** `terminology.<uid of the matched term>`, from the first
  pull request on. The globally unique identifier cannot collide with an
  old numeric rule id, which a new term id could. Saved findings keep the
  old ids (`documents.last_findings`), and the editor uses the rule id to
  recognise the same finding across checks
  (`frontend/src/findings/equivalence.ts`). After the migration the first
  check of a document therefore does not carry over the selection and the
  cached suggestion of its terminology findings, once per document. This
  is accepted; saved findings are not rewritten.
- **Overlapping findings within one domain:** as today, a status finding
  wins over a casing finding. Between two status findings the more severe
  one is kept; if both have the same severity, both are kept. A casing
  finding is dropped when it overlaps any status finding that is kept,
  also a warning.
- **Several domains: unchanged.** The checker runs per domain in the
  order the request gives, and a later domain's finding is dropped when
  an earlier domain already reported an overlapping span. A concept
  shared by two of the domains is therefore reported once. This holds
  between findings only: if one domain prefers a word and another forbids
  it, the error is reported whatever the order. The order itself is not
  defined today (it follows how the selection was made in the browser).
  Both points are left as they are and belong to #211, and so does a
  third: the rule that drops a later domain's overlapping finding does
  not look at severity, so a warning of an earlier domain hides an error
  of a later one.

## 9. API

### 9.1 First pull request: existing endpoints as a translation layer

The eight endpoints in `backend/app/api/terminology.py` keep their paths
and shapes. An old-style term is one language section seen through one
domain:

| Old field | Source |
|---|---|
| `id` | the language section's id |
| `domain_id` | the one domain of the section's concept |
| `preferred` | the section's active preferred term |
| `forbidden_variants` | the section's forbidden terms |
| `definition` | the section's definition |
| `case_sensitive` | the preferred term's value |

Creating a term creates a concept with one section. Updating renames the
preferred term and adds or removes forbidden terms to match the list.
Deleting removes the section, and the concept when it was the last one.
All of these go through the store and are logged with origin `manual`.
While this layer exists nothing can create a shape it cannot express; in
particular every concept is in exactly one domain. `PUT` and `DELETE` on
`/api/terms/{id}` have no domain in their path and find it through the
section's concept. The old screen holds no version numbers, so each of
these endpoints reads the current state and saves with the numbers it
just read. For the writer this is "last save wins", as today.

The layer lives in the API module. The old store methods are replaced by
the new ones, so the store tests are rewritten; "unchanged" applies to the
API tests. Empty or duplicate variants, and a variant equal to the
preferred wording, are dropped silently, as in the migration. Variants are
returned in the order their terms were created.

The checker in the first pull request reads the new tables and reports
exactly as before: an error for a forbidden term and an error for a
case-sensitive preferred term in the wrong case.

### 9.2 Third pull request: concept endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/domains/{id}/concepts` | All concepts of a domain, complete (sections, terms, domain ids). |
| `POST /api/domains/{id}/concepts` | Create a concept in this domain. |
| `GET /api/concepts/{id}` | One concept. |
| `PUT /api/concepts/{id}` | Save several parts in one request: the language sections it lists and, if given, the complete list of domain links. A section that is not listed is left untouched; a section listed without terms is removed. Optional comment. |
| `PUT /api/concepts/{id}/languages/{language}` | Save one language section: its definition and terms. Creates the section if the concept has none in that language; sent without terms, it removes the section. Optional comment. |
| `DELETE /api/concepts/{id}` | Delete the concept. |
| `DELETE /api/domains/{id}/concepts/{concept_id}` | Remove from this domain only. |

A language section is identified by its language, which never changes.
Within a section, terms are matched by id; ones without an id are
created, missing ones are deleted. Every response carries the version
numbers of all three levels. Every section in a save carries the id and
the number that were read (neither for a new language); domain links are sent as the
complete list, including the domain the entry was opened from, together
with the concept's number (5.7). Each request is one transaction and one
batch in the change log. A new concept is created with its first save,
whichever button is used.

Status codes follow the existing endpoints: 403 for a global row and a
non-admin; 404 for a concept or domain that is not visible; 422 for an
invalid value (empty term text, unknown language or pick-list value); 409,
with a message naming the rule, for a save that would break a rule from
5.3 or 5.4 (duplicate wording in a section, a second active preferred
term, no section or no domain left, a domain with a different owner),
and for a save whose version number is out of date. That answer names the
part that was changed in the meantime: the language, or the domain links.

The old term endpoints, their models, the translation layer and
`terms_legacy` are removed in this pull request.

## 10. Screen

The mockup shows both screens. It fixes structure and placement; styling
uses the existing components and theme tokens.

**Concept list** (replaces the term table)

- One row per concept: label, the other wordings in the chosen language
  with their status, the languages that have terms, the other domains the
  concept is in.
- Language selector, search over all wordings, and a button to add a
  concept. The selector starts on the language of the user interface.
  Labels and search are computed in the browser from the complete list,
  as the term table does today; there is no paging.
- A candidate term is visibly distinct from an active one.
- Status is never shown by colour alone; each chip carries text or an
  accessible name.

**Concept entry** (opens from a row, replaces the list, with a way back)

- "Also in domains": the other domains of the same owner, to add or
  remove.
- One section per language: definition, then the terms with usage status,
  process status and reason. Details per term hold context, source, part
  of speech and case sensitivity.
- Adding a term, adding a language.
- **Saving.** Each language section has its own save and discard, active
  only while that section has unsaved changes, so a long entry can be
  saved language by language. "Save all" sends, in one request, only the
  sections with unsaved changes, and the domain links only if they were
  changed. Sections without unsaved changes are not sent, so a language
  that someone else added or edited in the meantime is not touched. What
  a language save has stored stays stored when the rest is discarded
  later.
- **A save refused as out of date** keeps the edits on screen and says,
  next to the button that was used, which part someone else changed in
  the meantime, with an action to load the current version of that part.
  Loading it discards the writer's edits to that part, after asking.
  There is no merging in T1.
- Removing a language is an explicit action in its section.
- Unsaved changes are marked per section. A failed save keeps the edits
  on screen with the error next to the button that was used.
- One optional "reason for this change" field; whichever save is used
  next stores it as the log comment.
- Leaving with unsaved changes asks first.
- "Remove from this domain" and "Delete concept" are separate actions.
  The first is unavailable when the concept is in no other domain.
- Read-only for a global concept unless the user is an admin, as for
  global domains today.
- Deleting a domain states how many concepts will be deleted with it.

**Intended extension points, not built now:** custom fields appear as
further rows in the concept header, the language section or the term
details, depending on where they attach. A column chooser can add
concept-level fields to the list.

## 11. Calls made by the author

These were not discussed explicitly. Each can be changed without affecting
the rest.

1. **One log entry per changed subject, grouped by a batch identifier.**
   The issue says "one save is one entry" and also that an entry names one
   concept and at most one term. The entry screen saves many terms at
   once, so both cannot hold literally. Entries per subject keep "the
   history of this term" a simple query; the batch keeps the save
   together.
2. **Process status is our own attribute.** TBX-Basic has no such data
   category, so it will not appear in a TBX-Basic export. The name
   follows general terminology usage.
3. **Created and modified are null on migrated rows** instead of the
   migration date, because the true values are unknown. The carried-over
   log entry holds the migration date.
4. **`terms_legacy` is kept until the third pull request.**
5. **A language section needs at least one term**, as in TBX-Basic. A
   definition cannot exist for a language without a term.
6. **Removing a concept from its last domain is refused** instead of
   deleting it silently.
7. **A wrongly cased admitted term is an error**, like a preferred one.
8. **No database constraint for the one-preferred rule.** The store
   checks it inside the save transaction, after locking the concept row
   (5.3). A unique index would cover this one rule only and would have to
   be rebuilt for every new enforced process status.
9. **Adding a language is checked by the language still being absent**,
   not by the concept's version number, so that two people can add
   different languages at the same time. The concept's number is checked
   for domain links only.
10. **Deleting and removing are not checked against version numbers.**

## 12. Verified against TBX-Basic version 4

Read from the specification text
(https://www.terminorgs.net/downloads/TBX-Basic-V4.pdf):

- Usage status is a term-level pick-list with exactly preferred, admitted
  and deprecated, one value per term (6.23). There is no forbidden value.
- The specification sets no limit on how many terms of a concept may be
  preferred. The limit in 5.3 is our decision.
- Definition is allowed at concept and language level (6.5); context,
  part of speech and the source of a term at term level (6.1, 6.12, 6.17).
- Part of speech values: noun, verb, adjective, adverb, properNoun, other.
- Transaction type (creation, modification), responsibility and date are
  allowed at concept, language and term level (6.4, 6.14, 6.22).
- A concept entry needs at least one language section, a language section
  at least one term section (7.1, 7.2).

Not verified: the status list on https://datcatinfo.net/, whose value
tables could not be read. It no longer decides anything, because the
status list is settled as the three TBX-Basic values plus forbidden.

## 13. Delivery

| Pull request | Content | The app afterwards |
|---|---|---|
| 1 | Sections 5, 6, 7 and 9.1; seeding; import tool | Looks and checks as before; changes are being logged |
| 2 | Section 8 | Same screen; the checker honours statuses (only reachable through data once PR 3 lands) |
| 3 | Sections 9.2 and 10; removal of the old endpoints and `terms_legacy` | New screen |

Each pull request updates `docs/backend-architecture.md` or
`docs/frontend-architecture.md` and the logbook.

## 14. Testing

- **Migration**, on both backends: a database with old terms (several
  languages, global and owned domains, duplicate and empty variants)
  migrates to the expected rows and log entries; a second start changes
  nothing; check results before and after are identical.
- **Store rules** from 5.3 and 5.4, each with a test that fails when the
  rule is removed.
- **Change log:** every writing method produces the expected entries;
  nothing is written for a no-op save; no store method can update or
  delete an entry.
- **Checker:** the severity table, candidates ignored, the replacement
  fallback, a shared concept in two domains reported once.
- **Version numbers:** each level's number and modified fields change
  exactly as defined in 5.7; a save with an out-of-date number is refused
  and writes nothing; two saves of different languages made from the same
  read both succeed.
- **Simultaneous saves** on Postgres: several processes save the same
  language section with the same version number, each adding a preferred
  term; exactly one succeeds and the others are refused as out of date.
  A second test fixes the order of the two transactions. Both must fail
  when the initial write to the concept row is removed.
- **Translation layer:** the existing API tests pass unchanged in the
  first pull request.
- **Screen:** list labels including the fallback, saving one language
  without touching the others, "Save all" as one request that contains
  only the changed parts, a refused save keeping the edits, the two
  removal actions, read-only global concepts.

## 15. Left to the builder

- Method names and signatures of the store, and the Pydantic and
  TypeScript models.
- Indexes.
- Exact wording of messages and labels in the seven locales.
- Component structure of the new screen.
