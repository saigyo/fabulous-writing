# Editable terms & domain rename in the terminology view — design

Date: 2026-07-07
Status: approved

## Goal

Terms in the terminology table (and domain names in the domain list) can be
edited in place. Today the UI offers only create and delete; fixing a typo
means deleting and re-entering a term.

## Scope

Frontend only. The backend already provides partial-update endpoints, both
covered by existing API tests:

- `PUT /api/terms/{term_id}` with `TermUpdate` (all fields optional)
- `PUT /api/domains/{domain_id}` with `DomainUpdate` (all fields optional)

The typed client already has `updateTerm`; an `updateDomain(id, name)`
function is added (sends `{name}` only, leaving `description` untouched).
No backend changes.

## Term row editing (TermTable)

Interaction pattern: **row edit mode** (chosen over click-to-edit cells and
a modal dialog — it reuses the add-term row's widgets and introduces no new
UI patterns).

- `TermTable` gains `editingId: number | null` and a draft state:
  `{ language, preferred, variants, definition, caseSensitive }`, where
  `variants` is a single comma-separated string (same authoring format as
  the add-term row).
- The actions cell of every row shows ✎ (edit, `title` = `editTermTitle`)
  next to the existing delete ✕.
- Clicking ✎ puts that row into edit mode: the language / preferred /
  do-not-use / definition cells render the same widgets the add-term row
  uses (select, inputs, `Aa` case toggle), initialized from the term;
  `forbidden_variants` are joined with ", ".
- In edit mode the actions cell shows ✓ save (`saveEditTitle`) and ✕ cancel
  (`cancelEditTitle`); the delete button is not offered.
- **Save**: trim fields; require non-empty `preferred` (otherwise ignore the
  save, as `addTerm` does); split variants on commas, trimming and dropping
  empties; call `updateTerm` with the full field set; refresh via the
  existing `onChanged()`; leave edit mode.
- **Cancel**: discard the draft, leave edit mode.
- Keyboard: Enter in any input saves; Escape cancels.
- ✎ on a different row switches editing to that row, discarding the current
  draft silently.
- Sorting and filtering keep operating on the saved terms array; a row in
  edit mode does not move while being edited. After save it may re-sort or
  drop out of the active filter — accepted, normal behavior.
- If the edited term is deleted elsewhere (stale id), the PUT returns 404;
  the row refresh via `onChanged()` removes it. No special handling.

## Domain rename (domain list)

- Each domain row gets a ✎ `icon-button` beside the existing delete ✕;
  clicking it — or double-clicking the domain name — swaps the name for a
  text input initialized with the current name (`renameDomainTitle`).
- Enter saves via `updateDomain(id, trimmedName)` and refreshes the domain
  list (`refreshDomains()`); the header's domain multi-select picks up the
  new name through the shared store. Escape cancels. Empty or
  whitespace-only names are not saved (rename stays open until corrected or
  cancelled). Blur without Enter cancels.
- Clicking ✎ does not change the domain selection; double-click on the name
  selects the domain first (existing click handler), which is fine.

## Logic extraction & tests

The conversions live as pure functions in `termTable.ts` (colocated tests in
`termTable.test.ts`, written test-first):

- `parseVariants(input: string): string[]` — comma-split, trim, drop
  empties (extracted from `addTerm`, which switches to it).
- `termToDraft(term: Term): TermDraft` — including the ", " join.
- `draftToTermPayload(draft: TermDraft): payload | null` — trims, returns
  `null` when `preferred` is empty (caller ignores the save).

The component stays thin; row rendering logic is not unit-tested (consistent
with the codebase — component behavior is covered by the end-to-end pass).

## i18n

New keys in `messages.ts` and all seven locales (en, de, es, fr, it, ja,
zh): `editTermTitle`, `saveEditTitle`, `cancelEditTitle`,
`renameDomainTitle`.

## Verification

- `vitest` green (new termTable tests included); `npm run build` green.
- End-to-end with headless Chrome against the live dev servers: edit a term
  (all four fields + case toggle), save, verify the table and a subsequent
  GET reflect it; cancel discards; Enter/Escape work; rename a domain and
  verify the list and header multi-select update.

## Out of scope

- Editing a term's domain (moving terms between domains).
- Editing domain descriptions (not shown in the UI today).
- Concurrent-edit conflict handling beyond the 404-refresh behavior above.
