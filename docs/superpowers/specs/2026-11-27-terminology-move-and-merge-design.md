# Terminology: moving terms and merging concepts

Date: 2026-11-27. Builds on the concept model
(`2026-11-22-terminology-t1-concept-model-design.md`, called "the concept
spec" below); its terms, rules and section numbers are used here.

## 1. Intent

A writer creates concepts one by one, often with a single term each, and
later sees that several of them mean the same thing. Today the only way to
pull them together is to retype the terms in one concept and delete the
others. The reverse case exists too: a term was filed under the wrong
concept and should stand on its own or belong elsewhere.

This adds three actions:

- **Merge** a concept into another one. All its terms move, and the
  emptied concept is deleted.
- **Move** one term to another concept.
- **Move one term to a new concept**, which splits it off.

## 2. Goals, non-goals, anti-goals

**Goals**

- One operation in the store carries all three actions, so their rules
  exist once.
- The writer sees the exact outcome before confirming, including
  everything that will be lost.
- A moved term stays the same term: its identifier (`uid`), its fields and
  its history travel with it.

**Non-goals**

- Undo. A merge is reversed by hand, by moving terms to a new concept.
- A target outside the domain the writer is looking at.
- Moving several chosen terms in one step in the screen, and merging more
  than two concepts at once.
- Changing a concept's owner. Source and target always have the same
  owner.
- A screen for the change log.

**Anti-goals**

- A confirmation that promises something other than what then happens.
- A merge that silently discards content. Whatever is not taken over is
  named in the confirmation.

## 3. Approaches

1. **The server works out the outcome, as a preview of the same
   operation.** Each endpoint has a preview mode that changes nothing and
   returns the outcome; the dialog displays it. Confirming runs the same
   call for real, with the version numbers of the preview. Costs one
   request per target picked. **Chosen**, because the rules exist once and
   the confirmation cannot disagree with the result.
2. **The browser works out the outcome** from the two concepts it has
   already loaded. No extra request, but the rules for preferred terms,
   duplicates, definitions and domains would exist twice.
3. **The existing save calls**, target first, then deleting the source.
   Dropped: two steps that can fail halfway, and the moved terms would be
   new terms without their identifier and history.

## 4. The operation

One store method moves a set of terms of one concept (the **source**) to
another concept or to a new one (the **target**). A merge is that method
for all terms of the source. Everything happens in one transaction and one
batch of the change log.

### 4.1 Preconditions

- The actor may write both concepts (concept spec 5.4): 404 for a concept
  that is not visible, 403 for a global concept and a non-admin.
- Source and target have the same owner, and are not the same concept.
- Every term to move belongs to the source.
- A new concept as target needs the `custom_domains` feature, as creating
  a concept does. An existing target needs no feature.

### 4.2 What happens to a moved term

A term goes to the target's section of the same language. If the target
has none, the section is created.

- **Fields.** `uid`, wording, both statuses, reason, context, source, part
  of speech and case sensitivity are kept.
- **Preferred.** If the term is active and preferred, and the target's
  section already has an active preferred term, the moved term becomes
  admitted. The target's term is never changed. In every other case the
  usage status is kept.
- **Same wording.** If the target's section already has a term with
  exactly this wording (the uniqueness rule of concept spec 5.2):
  - in a merge, the target's term stays as it is, with its own status, and
    the incoming one is deleted. This holds even when the incoming term
    was preferred and the target's is not; the section may then have no
    preferred term, which concept spec 5.3 allows;
  - in a move of one term, the operation is refused.

  The wording is compared first. Only a term that is taken over is then
  checked for the preferred rule above.

### 4.3 What happens to the source

- A section that loses its last term is removed (concept spec 5.3).
- A concept that loses its last section is deleted. In a merge this is
  always the case.

### 4.4 Definitions

When a section of the source is removed, its definition is taken over by
the target's section of that language if that section has no definition
(or was just created). Otherwise the source's definition is dropped. A
section of the source that keeps at least one term keeps its definition;
the target gets none from it.

### 4.5 Domains

- An existing target keeps its domain links unchanged. Both differences
  are reported: domains the source is in and the target is not, where the
  moved terms stop applying, and domains the target is in and the source
  is not, where they start applying. *(Author's call for the second: a
  forbidden term that starts raising findings in another domain is an
  effect the writer should see before confirming.)*
- A new concept gets the domain links of the source. *(Author's call:
  splitting a term off should not change where it applies.)*

### 4.6 Version numbers

The rules of concept spec 5.7 apply to every change the operation makes:
a section that gains or loses a term or changes its definition, a concept
that gains or loses a section, a term whose status changes. Moving counts
as a change of the term itself, so a moved term's own number increases
too. A section created by the operation starts at 1, as does a new
concept.

The operation is checked against a **basis**: for the source and for an
existing target, the concept's number and the id and number of every
section. The preview returns the basis; the real run sends it back. If
anything in either concept differs from the basis, the run is refused and
nothing is written. This is stricter than a normal save, which only
compares the parts it writes, because the preview showed both concepts as
a whole.

Locks are taken before anything is read, in the store's existing order:
first the domain rows a new concept will be linked to (as `create_concept`
does), then the concept rows, in ascending order of their ids, so that
two operations on the same pair cannot block each other.

### 4.7 Preview

Both endpoints take `preview`. A preview applies the same checks,
including the permissions of 4.1, and the same code as the real run, writes nothing that outlasts the request, and
answers with the same body. *(Author's call: the simplest way to guarantee
"the same code" is to run the operation in its transaction, read the
result and roll back. The builder may choose another way if previews and
real runs still share one implementation of the rules in 4.2 to 4.5.)*

A preview needs no basis. Its answer for a new concept shows that concept
for display only; its ids do not exist afterwards.

### 4.8 Change log

One batch per run, following concept spec section 7, with two new actions:

- `moved`, on each moved term. The entry belongs to the target concept and
  lists the change of concept (old and new `uid`) and, if it changed, the
  usage status. A moved term gets no `created` or `deleted` entry, also
  when the target is a new concept.
- `merged`, on the source concept of a merge, in place of `deleted`. It
  names the target concept.

Everything else uses the existing actions as they are written today:
`deleted` for a term dropped as a duplicate and for a source concept
emptied by a move; `edited` on a concept whose definition changes, which
includes a definition taken over or dropped; `created` for a new concept,
on the concept only. The acting user, the origin (`manual`) and the optional comment
are passed as for every write.

## 5. API

| Endpoint | Purpose |
|---|---|
| `POST /api/concepts/{id}/merge` | Merge concept `{id}` into `target_id`. |
| `POST /api/terms/{id}/move` | Move term `{id}` to `target_id`, or to a new concept when `target_id` is null. |

Request body, both: `target_id`, `preview` (default false), `basis`
(required unless `preview`), `comment` (optional).

Answer, both, for a preview and a real run alike:

| Field | Content |
|---|---|
| `target` | The target concept after the operation, complete as in the concept endpoints. |
| `source` | The source concept after the operation, or null if it was deleted. |
| `moved` | Per moved term: id, wording, language, usage status before and after. |
| `dropped_terms` | Per term not taken over as a duplicate: wording, language and usage status. |
| `dropped_definitions` | Per definition not taken over: language and text. Empty definitions are not listed. |
| `removed_languages` | Languages whose section the source lost, when the source still exists. |
| `dropped_domains` | Domains the source is in and the target is not: id and name. |
| `added_domains` | Domains the target is in and the source is not: id and name. |
| `basis` | The basis of 4.6, as read before the operation. |

Status codes follow the concept endpoints: 403 and 404 as in 4.1; 422 for
an invalid body, and for a real run without a basis; 409 with the object
`{code, message}` for a broken rule (different owners, the same concept as
source and target, the same wording in a move) and for a basis that is out
of date. The out-of-date answer also names which concept changed.

## 6. Screen

The mockup `2026-11-27-terminology-move-and-merge-mockup.html`, next to
this document, shows every state of both dialogs and where the two
actions sit in the entry. It is binding for structure, order, spacing
relations, the English texts and which button is filled, red or
unavailable in which state. It is drawn with the app's own tokens and the
values of the existing classes (`dialog.app-dialog`, `.plain-button`,
`.primary-button`, `.confirm-dialog-danger`, `.status-chip`,
`.language-marker`, `.link-button`); the implementation uses those
classes and adds new ones only for the parts that have no counterpart:
the suggestion list, the result rows, the mark on an incoming term and
the box with the amber edge. The texts of the other six languages follow
the English ones.

### 6.1 Where the actions are

- **"Merge into…"** in the header of the concept entry, next to "Remove
  from this domain" and "Delete concept".
- **"Move…"** in the details of each term.

Both are available only when the entry has no unsaved changes and no save
is running, the concept is not read-only, and the term is a saved one.
"Merge into…" also needs at least one possible target.

### 6.2 Picking the target

The target is picked by typing into a search field.

- **Candidates:** the concepts of the domain the writer is in, without the
  source. They come from the list the view has already loaded. All
  concepts of one domain have that domain's owner, so they have the
  source's owner too.
- **Matching:** as the search above the concept list: the typed text is
  found in any term of any language.
- **Each suggestion:** the concept's label as in the list, its other
  wordings with the match highlighted, and its languages.
- **Order:** labels that start with the typed text first, then the rest,
  each alphabetically.
- **Before typing:** all candidates are listed.

### 6.3 The merge dialog

Title "Merge "X" into another concept", a line saying that X is deleted
and its terms move, and the target field. Once a target is picked:

- The target as it will be afterwards: one row per language with the
  status chips of all its terms. Incoming terms are marked as new. A term
  that arrives as admitted instead of preferred has a line saying so.
- A box "Not taken over", shown only if it has entries: duplicate terms
  with their status, dropped definitions with their text, and the domains
  where the moved terms stop applying.
- A line naming the domains where the moved terms start applying, if any.
- "Cancel", and a red button "Merge and delete "X"".

### 6.4 The move dialog

Title "Move "term"", and a choice between "To the concept" with the target
field and "To a new concept". Once the choice is complete:

- A box "This also happens", shown only if it has entries: the change from
  preferred to admitted, a language the source loses with its dropped
  definition, a definition that is dropped because the source concept is
  deleted, the domains where the term stops or starts applying, and the
  deletion of the source concept when the term is its last.
- "Cancel" and "Move". When the source concept is deleted, the button is
  red and names the concept.
- A move that is refused for the same wording shows the reason in place of
  the box, and "Move" is unavailable.

### 6.5 Behaviour

- Every change of the target requests a new preview. Only the answer to
  the latest request is displayed; the confirm button is unavailable while
  one is running.
- Confirming sends the basis of the preview on display, and the entry's
  "reason for this change" as the comment if one is typed, as the next
  save would. The dialogs have no comment field of their own.
- While the real run is in progress the dialog cannot be closed, so that
  its answer always reaches the entry.
- If the run is refused as out of date, the dialog says which concept was
  changed in the meantime and loads a new preview. The writer confirms
  again.
- After a merge, the entry shows the target concept. After a move, the
  entry keeps showing the source; if the source was deleted, it shows the
  target. *(Author's call: a writer who moves one term often moves the
  next one from the same concept.)*
- The concept list of the view reflects the result without a manual
  reload.
- All new texts exist in the seven languages of the user interface, in the
  informal register.

## 7. Calls made by the author

Marked in the text. In short: a new concept inherits the source's domains
(4.5); domains where moved terms start applying are reported as well
(4.5); the preview is the real operation rolled back (4.7); after a move
the entry stays on the source (6.5); the entry's reason field is the
comment (6.5). Also: the API moves one term per
request, since the screen needs no more; a preferred term that is only a
candidate is never demoted, because the rule of concept spec 5.3 counts
active terms only.

## 8. Testing

- **Store, on SQLite and Postgres:** every rule of 4.2 to 4.6 with its own
  test; a preview leaves rows, version numbers and the change log
  unchanged and returns the same answer as the real run that follows; a
  run with an outdated basis writes nothing; two runs on the same pair at
  the same time, raced as processes.
- **API:** status codes of section 5, the feature gate for a new concept,
  ownership for a non-admin on global concepts.
- **Screen:** availability of the two actions, the candidate list and its
  order, both dialogs for each kind of entry they can show, the latest
  preview winning over a late one, the out-of-date case, and what the
  entry shows afterwards.
- A trial in the browser on a scratch stack before the final review.

## 9. Left to the builder

- Names of the store method, the models and the rule codes.
- How a preview avoids lasting writes, within 4.7.
- How removed sections and taken-over definitions appear in the `changes`
  of the log entries, within concept spec section 7.
- Layout details of the dialogs and of the suggestion rows.
- Whether the view updates its list from the answer or reloads it.
- Delivery as one pull request or as two (store and API, then screen).
