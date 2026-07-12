# Frontend architecture

The frontend is a React 19 + TypeScript single-page app built with Vite. It has three
main ingredients:

- **CodeMirror 6** for the editor — and, less obviously, as the *source of truth for
  finding positions* (a CodeMirror `StateField` keeps spans correct while the user
  keeps typing);
- **zustand** for application state (one store, a small persisted slice);
- a thin typed **API client** over `fetch` + `EventSource` against the backend
  (`VITE_API_URL`, default `http://localhost:8000`).

There is no router; four views (editor, rules, terminology, profiles) are switched by a
store field. The editor workspace is special-cased: it is hidden (`hidden` attribute)
rather than unmounted while another view is shown, because the findings — including
paid-for LLM results — live in the CodeMirror instance and would be discarded by a
remount; hiding also lets an in-flight LLM check deliver while the user reads another
view. Logic lives in plain TypeScript modules with colocated vitest tests;
components stay thin.

## Module map

```
frontend/src/
├── main.tsx / App.tsx        # bootstrap; header, view switch, data-loading effects
├── types.ts                  # shared API types (Finding, Profile, ...) — mirrors backend models
├── api/client.ts             # typed fetch wrappers + SSE subscription
├── state/store.ts            # the zustand store (single source of app state)
├── editor/
│   ├── Editor.tsx             # CodeMirror setup, update listener, click-to-select
│   ├── findings.ts            # findingsField StateField: tracked findings + decorations
│   └── editorRef.ts           # module-level handle to the EditorView
├── checking/
│   ├── scheduler.ts           # typing-pause debounce (fast vs. full check)
│   ├── controller.ts          # runCheck(): POST, apply fast findings, subscribe SSE
│   ├── model.ts               # effectiveModel(): chosen model vs. provider default
│   ├── routing.ts             # resolveModel(): tier → provider/model, explicit failure
│   ├── suggest.ts             # on-demand LLM suggestions / sentence rewrites
│   ├── status.ts              # check-status line model (phase, timer, tokens)
│   └── vetMessage.ts          # "no reliable suggestion" message logic
├── findings/                  # pure helpers over findings
│   ├── equivalence.ts         # match findings across checks (id migration)
│   ├── group.ts / severity.ts / source.ts   # sidebar grouping & counter chips
│   └── suggestions.ts         # built-in suggestions win, else LLM-fetched extras
├── scoring/
│   └── score.ts               # pure scoring v1 (mechanics + craft + overall);
│                               # normative spec docs/scoring.md; golden tests
│                               # in score.test.ts pin the spec's worked examples
├── profiles/
│   ├── profile.ts             # apply/dirty/rule-activation logic (mirrors backend XOR)
│   └── ProfilesView.tsx       # profile management view
├── documents/
│   ├── buffer.ts              # write-through DocSnapshot cache (localStorage)
│   ├── autosave.ts            # debounced save, retry backoff, no-op suppression, auto-title
│   ├── documents.ts           # lifecycle verbs: open/create/rename/delete/init + startup replay
│   ├── profileApply.ts        # profile-apply suppression flag + applyHeaderProfileSelection
│   ├── list.ts                # summaryOf, refreshDocuments/refreshFolders, sortedByName
│   ├── folders.ts             # applyFolderDefaults, saveFolderDefaults, addFolder, renameFolderById
│   ├── hydration.ts           # hydrateFromDocument/hydrateFromBuffer, orphan replay, recoverSnapshot
│   ├── settings.ts            # settingsPayload: header state → DocumentSettingsPayload
│   ├── documentTime.ts        # relativeTime/absoluteTime (pure, Intl-based)
│   ├── grouping.ts            # groupDocuments: flat list → byFolder map + ungrouped
│   └── DocumentSidebar.tsx    # sidebar UI: list, new, rename, delete, folders
├── header/
│   ├── ProfileSelector.tsx    # profile dropdown + dirty marker + save/reset
│   ├── LlmSelector.tsx        # tier dropdown + resolved caption + advanced pin panel
│   └── DomainMultiSelect.tsx  # checkbox-dropdown for terminology domains
├── sidebar/
│   ├── Sidebar.tsx             # counters, filters, finding list, detail card
│   ├── findingList.ts          # withCurrentSpans, truncate (pure helpers)
│   └── Score.tsx               # ScoreBadge + ScorePanel (overall/mechanics/craft,
│                                # six dimension bars, staleness note)
├── hooks/
│   ├── useCrudError.ts             # shared { error, run, fail, clear } mutation-error wrapper
│   └── useDismissOnOutsideClick.ts # close a popover/menu on mousedown outside its ref
├── rules/                     # rule catalog view + per-profile toggles
├── terminology/               # domain/term management view; terms edit in place
│                              # (row edit mode shares TermFieldCells with the add
│                              # row; drafts/parsing in termTable.ts), domains
│                              # rename inline via ✎ or double-click
└── i18n/                      # 7 UI locales, hooks, interpolation
```

## State management

`state/store.ts` defines one zustand store. Three kinds of state live there:

- **Checking context** — `language`, `domainIds`, `tier`, `provider`, `model`,
  `llmAuto`, `profiles`, `profileId`. This is what a check request is built from.
- **Check results & UI** — `tracked` findings (mirrored out of the editor),
  `selectedId`, severity/source filters, `checkPhase` (`idle | fast | llm`), LLM error
  and live progress (`llmStartedAt`, `llmTokens`), `activeView`.
- **Per-finding caches** — fetched `extraSuggestions`, `rewrites`, and their
  pending/error states, keyed by finding id.

`tier: Tier | null` records the header's LLM mode: non-null is tier mode (`quality |
balanced | cheap | local`), `null` is pinned mode where `provider`/`model` are
authoritative. `routing: RoutingTable | null` holds the `GET /api/routing` response
(fetched at startup alongside providers) and is **ephemeral** — never persisted, since
availability is only meaningful for the current process.

The `persist` middleware is configured from one exported object, `persistConfig`
(`name`, `version`, `migrate`, `partialize`) — the store passes this same object (not a
copy) to `persist(...)`, and tests import the identical `persistConfig` rather than
re-declaring their own literal, so the persisted-shape contract used by the running
store and the one exercised by tests can never silently drift apart. `persistConfig`
(v2) saves a small cross-document slice to localStorage:
`uiLocale`, `lastProfileByLanguage`, `rulesCollapsed`, `currentDocId`,
`docSidebarCollapsed`, and `docFoldersCollapsed` (the sidebar's per-folder collapsed
state, added additively to v2 — a `number[]` of collapsed folder ids, no version bump
needed since it's a new key on an existing persisted shape rather than a change to an
existing one). Everything that used to live here in v1 — `language`,
`domainIds`, `provider`, `model`, `tier`, `llmAuto` — moved into per-document storage
(the backend's `settings` columns; see [Documents](#documents)) once multiple documents
each needed their own header configuration. Results, caches, and `routing` stay
ephemeral as before. A `migrate` step still handles the pre-tier persisted shape
(version 0): those users had explicitly chosen a provider/model, so they land in pinned
mode (`tier: null`) rather than silently switching to tier mode; version 1 passes
through unchanged into v2 (its now-stale header fields are harmless extras that the
legacy-document migration in `documents.ts` reads once, then ignores).

Two store behaviors deserve a note:

- **`setTracked` migrates caches.** Findings get fresh ids on every check, so fetched
  suggestions keyed by id would die on each re-check. `mapEquivalentIds` (see below)
  maps old ids to their equivalents in the new list and the caches are re-keyed;
  entries whose finding disappeared are dropped.
- **`setProvider`/`setModel`/`setPinned` pin.** Touching the advanced provider/model
  selectors sets `tier: null` (pinned mode) alongside the new value — mirroring
  `LlmSelector`'s Advanced panel, where picking a concrete provider or model always
  overrides tier mode. In tier mode the panel displays the tier's *resolved* pair
  (not the last pin), and a "Pin this model" button adopts it via `setPinned`.
- **`selectProfile(profile, apply)`** records the selection (per language, persisted)
  and, when `apply` is true, copies the profile's domain and LLM values (tier, or
  pinned provider/model — see `applyProfileToHeader` below) into the header selectors.
  `apply` is only true on user action and real language switches — not on data
  refreshes, which would silently wipe user overrides.

**Quality score state.** The store tracks `scorecard: Scorecard | null` (the last LLM
scorecard for the current document), `scorecardStale: boolean`, and `docWords: number`
(current word count, gating the "too short" state). `scoring/score.ts` — a pure module
with `docs/scoring.md` as its normative spec — combines the current `tracked` findings
and `docWords` into a deterministic **mechanics** score, folds in the scorecard's six
dimensions into a **craft** score when one is present, and derives the **overall**
badge value; golden tests in `score.test.ts` pin the spec's worked examples. Applying a
one-click fix removes a finding and re-scores instantly, client-side, without a new
check. `setScorecard` clears staleness; any editor edit after a scorecard has been set
calls `markScorecardStale`, which only flips the flag if a scorecard exists (findings
have no analogous concept, since they're position-tracked and self-correct as the user
types). `sidebar/Score.tsx` renders the badge (`ScoreBadge`, in the header row) and an
expandable panel (`ScorePanel`) with per-dimension bars and notes; both show a
mechanics-only note when no scorecard exists yet and a staleness note when one does but
is out of date.

## The editor and finding positions

`editor/findings.ts` is the heart of the frontend. Findings arrive from the backend
anchored to a text snapshot; the user may have kept typing since. Rather than
re-anchoring, the spans live *inside* the editor as a CodeMirror `StateField`
(`findingsField`), whose update function maps positions through every document change:

- On `docChanged`, each tracked finding's `from`/`to` is mapped through the
  transaction (`tr.changes.mapPos`); findings whose range was directly edited
  (`touchesRange`) or collapsed to zero length are dropped — their diagnosis no longer
  applies.
- `mergeFindingsEffect` replaces findings *per source*: a fast check replaces
  `rule`/`terminology` findings while LLM findings stay; the LLM result later replaces
  only `llm` findings. This is why rule findings never flicker while an LLM round-trip
  is in flight.
- The field `provide`s `EditorView.decorations`, so highlights (category-colored
  marks, selected-state) derive directly from the same data — there is no separate
  decoration bookkeeping.
- Selection is part of the field state (`selectFindingEffect`); clicking in the editor
  selects the finding under the cursor (`findingIdAt`: the *smallest* finding wins, so
  a whole-sentence finding never shadows the point findings inside it, and repeated
  clicks cycle outward through stacked findings), clicking a sidebar row dispatches the
  same effect, so editor and sidebar can never disagree.

The React side (`Editor.tsx`) is a single `useEffect` that creates the view with
`basicSetup + markdown() + findingsField`, persists the document to localStorage on
change, feeds the scheduler, and mirrors field changes into the store via
`setTracked`. The `EditorView` itself is shared through a module-level ref
(`editorRef.ts`) because non-React code (the check controller, suggestion appliers)
needs it — components never receive it as a prop.

Applying a fix is a plain CodeMirror transaction: `suggestionChange` replaces the
finding's *current* tracked span; `rewriteChange` finds the fetched sentence text in
the current document (never by stale offsets) and requires it to still overlap the
finding. Both return `null` when the target is gone — the button simply does nothing
harmful.

## The checking lifecycle

```
keystroke ──> scheduler.onInput()
                ├─ 1 s pause  → runCheck(includeLlm=false)   (rules + terminology)
                └─ 5 s pause  → runCheck(includeLlm=true)    (if llmAuto)
Check button ──> scheduler.checkNow() → runCheck(true)
```

`checking/scheduler.ts` is a pure debounce factory (fully unit-tested); the delays are
wired in `Editor.tsx`.

`checking/controller.ts` (`runCheck`) does one round-trip:

1. Snapshot the editor text. Resolve the active profile and build the request:
   `domain_ids` from the header (which the profile populated, possibly overridden),
   `rule_config` from the profile's category/exception lists, `llm_instructions` from
   the profile. The LLM provider/model come from `checking/routing.ts`'s
   `resolveModel(state)`: pinned mode (`tier === null`) resolves to the header's
   provider/model pair (falling back to the provider's default via
   `effectiveModel`); tier mode looks the language up in the fetched routing table. An
   unresolvable tier (routing entry missing, or reported unavailable) is an explicit
   failure — `runCheck` drops `llm` from the requested checkers, surfaces
   `llmSkipped(reason)` in the status line, and still runs the fast checkers
   (`rules`/`terminology`) so a misconfigured LLM tier never blocks rule/terminology
   feedback.
2. `POST /api/checks`. The response already contains the fast findings — they are
   merged into the editor immediately (replacing sources `rule`/`terminology`).
3. If the LLM is included, subscribe to the SSE stream (`subscribeCheck`). LLM findings
   replace source `llm` on arrival; `llm_progress` events drive the token counter;
   `checker_error` surfaces in the status line; `done` returns the phase to idle.

Three guards keep results consistent:

- **Staleness**: before merging, the controller compares the current editor text with
  the checked snapshot; if the user typed in between, the results are discarded (the
  next debounced check is already scheduled anyway).
- **Supersede**: a module-level `currentCheckId` ignores SSE events from any check that
  is no longer the latest, and a new `runCheck` unsubscribes the previous stream.
- **Cross-document cancellation**: `cancelCheck()` closes the current SSE subscription,
  clears `currentCheckId`, and resets `checkPhase`/`llmStartedAt`/`llmTokens` to idle.
  `hydration.ts`'s `hydrateFromDocument` calls it first, before doing anything else, so
  switching documents while a check is in flight can never let that check's late
  findings or scorecard land on — and be autosaved onto — the document the user
  switched to. This closed a real cross-document scorecard leak; `controller.test.ts`
  pins it directly (`cancelCheck() unsubscribes and blocks all late SSE writes`).

`checking/controller.test.ts` covers the controller directly: a late scorecard applying
to the right document, staleness marking a scorecard stale when the text moved on,
`cancelCheck()` blocking all late SSE writes, a newer check superseding an older one's
late findings, and stale-text discard. `checking/suggest.test.ts` covers
`fetchSuggestions`'s gating logic: a clean result populating suggestions and clearing
held-back, a vetoed result setting the error and held-back list without populating
suggestions, advice being stored independently of the veto outcome, and a second call
being skipped while one is already pending.

`checking/suggest.ts` implements the two on-demand LLM actions (drop-in suggestions,
whole-sentence rewrites) against `POST /api/suggestions`, using the finding's *current*
tracked span. Results and errors are cached per finding in the store; only one LLM
action runs at a time. When vetting rejected every candidate, `vetMessage.ts` turns
that into an honest "no reliable suggestion" message instead of an empty list.

An all-vetoed response still carries `held_back` candidates (the backend's revealable
spell-gate/rule-recheck rejects — see [backend-architecture.md](backend-architecture.md)),
and the store keeps them separately from the shown suggestions: `suggestHeldBack` and
`rewriteHeldBack` (`state/store.ts`) are per-finding, migrated across re-checks by the
same `setTracked`/finding-equivalence machinery as everything else. The sidebar
(`sidebar/Sidebar.tsx`) doesn't show them by default — the "no reliable suggestion"
message is paired with a `show-held-back` button ("Show N held-back suggestions"); only
on click does `HeldBackList` render each candidate as a dashed, warning-styled
`held-back-option`, with a localized `held-back-reason` line built by
`vetMessage.ts#heldBackReason` (`reason_kind: "rules"` names the rule ids it would still
trigger, `"spelling"` names the unrecognized words — one i18n string pair per language).
Applying a held-back candidate goes through the same `suggestionChange`/`applyRewrite`
apply path as a normal suggestion, so nothing about the edit itself is second-class; the
next check simply re-flags whatever issue made the candidate risky in the first place.

**Advice notes.** Parenthesized guidance the LLM couldn't express as a drop-in
replacement (the backend's `split_advice` — see
[backend-architecture.md](backend-architecture.md)) arrives on two channels: check-time
`finding.advice` and, for on-demand actions, per-finding `suggestAdvice`/`rewriteAdvice`
maps in `state/store.ts`, following the exact same lifecycle as the held-back maps
(populated on fetch, migrated across re-checks by `setTracked`/finding-equivalence). The
sidebar concatenates both sources (`[...finding.advice, ...fetchedAdvice]`) and renders
them unconditionally — alongside real suggestions, alongside the "no reliable
suggestion" message, and alongside the not-yet-fetched "Suggest fix"/rewrite buttons —
via `AdviceNotes` (`sidebar/Sidebar.tsx`), a plain `<p className="advice-note">💡
{note}</p>` with no `onClick` at all. This is deliberate, not an oversight: advice is
never a candidate for the apply path, so unlike every other action in the detail card it
gets no button, no handler, and no `stopPropagation` — a click on it does nothing but
bubble to the row's own select/deselect toggle.

## Finding identity across checks

`findings/equivalence.ts` defines when two findings from different checks are "the
same": same category, same rule id, same span text, overlapping position (nearest
match wins; the mapping is injective). This single definition powers both

- keeping the open detail card open across re-checks (the editor field re-selects the
  equivalent finding), and
- migrating the per-finding suggestion/rewrite caches in `setTracked`.

The sidebar (`sidebar/Sidebar.tsx` + `findings/` helpers) renders severity and source
counter chips (both are independent, combinable filters), groups findings by category,
and shows the detail card with built-in suggestions, fetched suggestions, and rewrite
options.

## Profiles in the frontend

`profiles/profile.ts` keeps profile semantics in one tested module, mode-aware
throughout (pin wins over tier wins over "no opinion", mirroring the backend's
precedence rule):

- `applyProfileToHeader(profile)` — the header values a profile selection implies. A
  pinned profile (`llm_provider` set) yields `{ tier: null, provider, model }`; a tier
  profile (`llm_provider` null, `llm_tier` set) yields `{ tier }` alone; a profile with
  no LLM opinion (both null) returns just the domain ids, leaving the header's LLM
  settings untouched.
- `isProfileDirty(profile, header)` — **dirty state is computed, never stored**: the
  header selectors are compared against the stored profile (domain sets, and either
  the tier or the provider/model pair, depending on the profile's mode). A pinned
  profile is dirty if the header is in tier mode at all, or the pair differs; a tier
  profile is dirty if the header is pinned, or the tier differs; a no-opinion profile
  is never dirty on the LLM fields. The dirty marker and save/reset buttons in
  `ProfileSelector.tsx` render from this predicate alone, so they can never drift.
- **Saving** (`ProfileSelector.tsx`, `ProfilesView.tsx`): the `PUT` payload always
  sends `llm_tier: tier`; `llm_provider`/`llm_model` are sent only when the header is
  pinned (`tier === null`), `null` otherwise — so saving writes exactly the header's
  current mode and clears the other one. `RulesView.tsx` echoes the profile's existing
  `llm_tier` back on its own rule-toggle `PUT`s, since the endpoint requires the field
  on every update (see [Checking profiles](backend-architecture.md#checking-profiles)).
- `effectiveRuleConfig(profile)` — the `rule_config` payload for checks, now including
  `packs_on` alongside `categories_off`/`exceptions`.
- `isRuleActive(profile, category, ruleId, pack)` — mirrors the backend's activation
  semantics: `(pack in packs_on AND category on) XOR exception` for pack rules (`pack`
  non-null), the plain `(category on) XOR exception` for general rules (`pack === null`)
  — so `RulesView` shows activation states without asking the server. `RuleInfo.pack`
  and `RuleInfo.examples` (bad/good, typed as `RuleExamples`) came from the backend's
  rule-pack feature; every `PUT`/POST profile sender (`ProfilesView.tsx`,
  `ProfileSelector.tsx`, `RulesView.tsx`'s `saveRuleSelection`) carries `packs_on` the
  same way it carries `categories_off`/`rule_exceptions`.
- `rules/catalog.ts`'s `splitByPack(rules)` partitions the catalog into `general`
  (non-packed rules, grouped by category exactly like `groupRulesByCategory`) and
  `packs` (one section per pack, packs sorted alphabetically, rules within a pack
  sorted by id). `RulesView.tsx` renders the general groups first, then a
  `.rules-pack` section per pack with its own heading checkbox: toggling it writes
  `packs_on` via `togglePack`, which — mirroring `toggleCategory`'s fresh-start
  semantics — also clears that pack's rules from `rule_exceptions`. Every `RuleCard`
  (general or packed) renders `rule.examples.bad`/`good` as "✗ Flags …" / "✓ Doesn't
  flag …" lines under the detail summary, so the rules view doubles as the
  user-facing rule documentation.

Profile loading lives in `App.tsx`: on startup and on language change, profiles are
fetched and the remembered profile for that language (`lastProfileByLanguage`,
persisted) — falling back to Standard — is selected. Header values are only *applied*
on a real language switch, detected by comparing a `prevLanguage` ref synchronously
(a consumed-boolean guard would break under React StrictMode's double-invoked
effects and wipe persisted header settings in dev).

`ProfilesView.tsx` manages profiles as stacked cards (name, domains, example text,
LLM instructions) with blur-to-save drafts; saving or resetting the selected profile
re-applies it to the header. Each card's LLM setting is a row of tier buttons
(`role="radiogroup"`) plus a collapsed Advanced panel (provider/model dropdowns,
mirroring `LlmSelector`'s header control): a resolved caption under the buttons shows
what a check with the profile would use (`resolveProfileModel`: the pin, or the tier
looked up in the routing table for the profile's language), and the Advanced panel
displays that resolved pair rather than blanks. Picking a tier button saves `llm_tier`
and clears the pin; opening Advanced and picking a provider/model — or clicking the
pin icon to adopt the displayed pair — saves the pin and implicitly leaves the tier
button unselected (the profile is now pinned). A `pinned-note` line with a clear (✕)
button appears whenever the profile is pinned, so returning to tier mode does not
require the Advanced panel. Each profile card also renders a row of **pack chips**
when the current language has any: `ProfilesView` fetches `GET /api/rules?language=…`
on mount and on language change (`getRules(language).then(r => setPacks(r.packs))`),
so the chip set is discovered per language rather than hardcoded — a language with no
packed rules simply renders no chip row. Clicking a chip toggles that slug in/out of
the profile's `packs_on` and saves immediately (the same blur-to-save `PUT`, sent with
every other field unchanged). Chip labels go through `packName(slug)`
(`i18n/en.ts` and friends): a small known-slug map (`marketing` → "Marketing",
`techdocs` → "Technical docs", `blog` → "Blog") with a title-case-and-de-hyphenate
fallback for any future pack slug the catalog introduces, so a new pack YAML file
gets a readable label without an i18n change. `RulesView.tsx` shows the
per-profile banner, category checkboxes, and per-rule switches that write through to
`PUT /api/profiles/{id}`.

**Shared CRUD-error handling.** `RulesView.tsx`, `ProfilesView.tsx`, and
`TerminologyView.tsx` (each a view whose actions are plain fetch-and-mutate calls, not
the document autosave path) share one error-surfacing hook,
`hooks/useCrudError.ts`: `useCrudError(format)` returns `{ error, run, fail, clear }`,
where `run(action)` wraps an async mutation, formatting any thrown error via `format`
and clearing it on success, while `fail(message)`/`clear()` let a caller with its own
try/catch (e.g. a load path that uses a different message formatter than the save path)
drive the same error state directly. `RulesView.tsx` routes **both** its load effect and
its save path through one `useCrudError` instance (`fail` on load failure, `clear` on
load start and on save success) so the single error slot cross-clears exactly as before
the views were split apart — a stale load error doesn't survive a successful save, and a
stale save error doesn't survive a language switch that starts a new load. `TerminologyView.tsx`
gained the same `{ error, run }` surface (previously it had none, so a failed
create/rename/delete of a domain or term failed silently); `ProfilesView.tsx` was
already error-surfaced and now shares the same hook rather than its own copy.

## Documents

`src/documents/` gives each piece of writing its own persisted text, check-state
snapshot, and header settings, backed by the `/api/documents` endpoints (see
[backend-architecture.md](backend-architecture.md#documents)):

- `buffer.ts` — a thin localStorage wrapper (`fabulous-writing-doc-buffer` key,
  `writeSnapshot`/`readSnapshot`/`clearSnapshot`) around one `DocSnapshot`: `docId`,
  `revision`, `dirty`, `name`, `text`, `findings`, `scorecard`, `settings`. It is a
  **write-through cache**, never the source of truth — it only bridges network
  failures and tab closes until the backend confirms the write (`dirty: false`).
- `autosave.ts` — the save engine.
- `documents.ts` — document lifecycle verbs only: `openDocument`/`createNewDocument`/
  `renameDocument`/`removeDocument`/`initDocuments` (startup replay, legacy-text
  migration), plus the folder-membership verbs `removeFolder`/`moveDocumentToFolder`
  that call the `/api/folders`/`/api/documents/{id}/move` endpoints and patch
  `store.folders`/`store.documents` in place; `createNewDocument(folderId?)` creates
  directly inside a folder and overlays that folder's defaults onto the create payload
  (`applyFolderDefaults`, see [Per-folder defaults](#per-folder-defaults) below). What
  used to be one large module is now split by concern into sibling files, each imported
  by `documents.ts` and by whichever other module needs it directly (no re-export
  layer):
  - `list.ts` — `summaryOf` (Document → DocumentSummary), `refreshDocuments`/
    `refreshFolders` (fetch + `docListError` on failure), `sortedByName`.
  - `folders.ts` — `applyFolderDefaults`, `saveFolderDefaults`, `addFolder`,
    `renameFolderById` (the folder CRUD/defaults verbs that patch `store.folders`
    in place and rethrow on failure so the sidebar's inline 409 handling works).
  - `hydration.ts` — `hydrateFromDocument`/`hydrateFromBuffer`, orphan-snapshot replay
    (`replayOrphanedSnapshot`), and 409/404 recovery (`recoverSnapshot`); see
    [Document lifecycle and self-write-aware recovery](#document-lifecycle-and-self-write-aware-recovery)
    below, unchanged in behavior by the split.
  - `profileApply.ts` — the one-shot profile-apply suppression flag
    (`consumeProfileApplySuppression`/`setProfileApplySuppressed`) and
    `applyHeaderProfileSelection`.
  - `settings.ts` — `settingsPayload(state)`, the single mapping from header state to
    the `DocumentSettingsPayload` shape, used by both autosave snapshots and document
    creation.
  This was a mechanical, behavior-preserving extraction (verified verbatim/byte-identical
  at every call site); it exists purely to keep each file's concern legible as the
  document/folder feature set grew.
- `DocumentSidebar.tsx` — the collapsible sidebar UI (`.doc-sidebar`; new/rename/delete,
  relative timestamps via `Intl.RelativeTimeFormat` — `documentTime.ts`'s
  `relativeTime(doc.edited_at, locale)`, **not** `updated_at`: the sidebar shows when the
  writer last actually edited the document, not when its row was last written, so a
  background check-and-save never changes the displayed time; `absoluteTime` renders the
  tooltip complement). `grouping.ts`'s `groupDocuments(documents, folders)` is an
  exported pure helper (unit-tested standalone) that buckets the flat, `edited_at`-
  recency-ordered document list by `folder_id` into a `Map<folderId, DocumentSummary[]>`
  plus an `ungrouped` array; a document whose `folder_id` points at a folder that no
  longer exists falls back to ungrouped rather than being hidden. `FolderGroup` renders
  each folder as a collapsible row (`docFoldersCollapsed`, persisted, toggled via
  `toggleFolderCollapsed`) with its own ⋯ menu (new document here / rename / delete —
  deleting keeps the documents and moves them to ungrouped, never destroys them).
  `NewFolderInput` is an inline ghost-styled text input reached from a folder-plus button
  next to "+ New document"; a 409 (duplicate name) keeps the input open with a `.conflict`
  red border instead of dismissing it. Each document's own ⋯ menu gained a "Move to
  folder ▸" submenu (between Rename and Delete) listing "No folder" plus every folder,
  disabling whichever entry matches the document's current location. Every menu/popover
  in the app — the document ⋯ menu and folder ⋯ menu (`DocumentSidebar.tsx`), the domain
  multi-select (`DomainMultiSelect.tsx`), and the LLM selector's advanced panel
  (`LlmSelector.tsx`) — now dismisses on any `mousedown` outside itself via the shared
  `hooks/useDismissOnOutsideClick.ts` (`ref`, `open`, `onDismiss`), replacing three
  previously separate, slightly-inconsistent ad hoc listeners with one tested behavior.

### Server-authoritative sidebar reordering: `patchDocumentSummary`

`store.patchDocumentSummary(id, patch: Partial<DocumentSummary>)` (`state/store.ts`) is
the one place the sidebar list is *re-ordered* after the initial load (create/move/delete
still mutate it via `setDocuments`), and it replaces the
older `touchDocument(id, name?)` helper. The old helper *assumed* every save meant "this
document is now the most recent" and unconditionally spliced the touched entry to the
front of the array with a freshly-minted client-side timestamp. That assumption broke
once check-triggered saves stopped being edits (see the backend's `edited_at`/
`checked_at` split in `docs/backend-architecture.md#documents`): a background
check-and-save with no typing would still call the old `touchDocument` and reorder the
sidebar, even though nothing the writer did changed.

`patchDocumentSummary` fixes this by being purely reactive to whatever the server
actually returned, never inventing a timestamp:

1. Merge `patch` into the matching document by `id` (fields like `edited_at`,
   `checked_at`, or `name`, taken verbatim from the API response that triggered the
   call — never `new Date().toISOString()`).
2. Re-sort the **entire** `documents` array by `edited_at` descending, tie-broken by
   `id` descending — `b.edited_at.localeCompare(a.edited_at) || b.id - a.id` — the exact
   same ordering the backend's `ORDER BY edited_at DESC, id DESC` produces, so the
   client-side re-sort and a full server refetch are always consistent.
3. No-op (returns the unchanged state) if `id` isn't found in `documents`.

Because the merged `edited_at` only moves when the server actually bumped it, a
document only jumps to the top of the sidebar when the writer genuinely edited text or
renamed it — exactly mirroring the backend's bump rules. Call sites, each patching only
the fields its own backend call actually returns/changes:

- `autosave.ts`'s `push()` patches `{ edited_at, checked_at }` from the `PUT` response
  after every save (whether or not `edited_at` moved that round) — this goes through
  `update_document`, so both fields are always current.
- `documents.ts`'s `renameDocument` (the sidebar's user-facing rename) also goes through
  `update_document` (a `PUT` with a new `name`), which bumps `edited_at` server-side; it
  patches `{ name, edited_at }` so a user rename both updates the label and re-sorts the
  document to the top.
- `maybeGenerateTitle` (auto-titling, `POST /generate-name`) goes through the backend's
  `set_name`, which **never** bumps `edited_at` (see
  `docs/backend-architecture.md#documents`); it patches only `{ name }`, deliberately
  omitting `edited_at` — an auto-assigned title must relabel the sidebar entry without
  moving it, since the writer didn't just edit the document.

This is what makes the acceptance case hold end to end: a fast/LLM check that lands as
an autosave with no text change patches `checked_at` (and bumps `revision`) but leaves
`edited_at` — and therefore sidebar order — untouched, while a real edit reorders the
sidebar the moment its save round-trips, without a page reload.

### The write-through buffer and autosave engine

`collectSnapshot()` assembles the current `DocSnapshot` from the editor (text) and the
store (tracked findings, scorecard, header settings) — always marked `dirty: true`, since
it describes *what should be saved*, not what has been. `noteChange()` (called from the
editor's update listener and from the header's settings-change effect) buffers that
snapshot synchronously via `writeSnapshot` and arms a 1.5 s debounce before calling
`flush()`, so a fast typist never fires one PUT per keystroke while a crash or reload
mid-typing still has a recent snapshot to replay.

`flush()` is also called synchronously at document-switch and `beforeunload` — points
where a save must be *attempted* immediately rather than waiting for the debounce. Two
guards keep this from causing redundant writes:

- **In-flight coalescing**: if a push is already in flight, `flush()` sets `pending` and
  awaits the same promise chain rather than starting a second concurrent PUT; the
  in-flight push's own completion handler fires the queued follow-up (`push`'s `finally`
  block), so callers that need the save to have truly landed (e.g. `openDocument`) get a
  promise that resolves only once the whole chain settles.
- **No-op suppression**: before writing anything, `flush()` compares the fresh snapshot
  against the buffered one (`sameContent`, a `JSON.stringify` comparison of `name`,
  `text`, `findings`, `scorecard`, `settings`). If the buffer is already clean
  (`dirty: false`), matches the same `docId`/`revision`, and the content is identical,
  `flush()` returns without writing the buffer or calling `updateDocument`. This closes a
  real bug found during end-to-end verification: `Editor.tsx`'s unconditional
  `beforeunload → flush()` PUT on every reload, even with zero edits, could be aborted
  client-side by the browser during navigation teardown *after* the server had already
  durably applied it — leaving the buffer `dirty` with a now-stale revision. The next
  boot then replayed that stale revision, got a genuine 409 against the client's own
  prior write, and unconditionally spawned a "(recovered)" duplicate. No-op suppression
  removes the trigger at the source: a plain reload with nothing changed now issues no
  PUT at all.

A failed push retries with exponential backoff (`RETRY_BASE_MS` 2 s, doubling to
`RETRY_MAX_MS` 30 s, reset on success) — except a 409/404, which hands off to the
conflict handler (`recoverSnapshot`, injected from `documents.ts` via
`setConflictHandler` to avoid a module cycle) instead of retrying blindly. `cancelRetry()`
lets a document switch take sole ownership of a pending retry before replaying it as an
orphaned snapshot (below).

**Auto-title trigger**: once a save succeeds, `maybeGenerateTitle` fires
`POST /documents/{id}/generate-name` exactly once per fallback-named document
(`titleAttempted` set, checked against `docMeta.nameSource === 'fallback'`), gated on the
text having reached `TITLE_WORD_THRESHOLD` (20) words — mirroring the backend's own
short-circuit for anything already titled or user-renamed.

### Document lifecycle and self-write-aware recovery

`documents.ts` owns the document list and the currently open document:

- `openDocument`/`createNewDocument`/`renameDocument`/`removeDocument` are the sidebar's
  verbs; `openDocument` and `createNewDocument` both `flush()` the outgoing document
  first so a switch never silently drops an edit. `removeDocument` falls back to
  creating a fresh document when the last one is deleted — there is always exactly one
  open document.
- `hydrateFromDocument(doc)` loads a document into the store and editor as **one**
  CodeMirror transaction (text replacement + `setFindingsEffect` together), so restored
  finding spans are never applied against the wrong text. It also copies the document's
  settings (language, domains, provider/model/tier, `llmAuto`, profile) into the header,
  setting a one-shot `suppressProfileApply` flag when the language changed so the
  header's own profile-apply effect doesn't immediately overwrite the document's stored
  settings with the newly-selected-profile's defaults (`consumeProfileApplySuppression`,
  read once by `App.tsx`).
- **`applyHeaderProfileSelection`** (called by `App.tsx`'s header language-switch effect
  once it has picked a profile to show) branches on that suppression flag together with
  the store's current `profileId`: if suppressed **and** `profileId === null` — the
  opened document supplied no profile, e.g. its `profile_id` was pruned server-side
  because the profile was deleted — it leaves the store untouched entirely and returns
  early. A pruned document has no profile; adopting the header's remembered-or-standard
  fallback into `profileId`/`lastProfileByLanguage`, even "for display only," would be
  durable in memory and get silently persisted onto the document by the next autosave
  (and inherited by the next document created from `currentSettings()`). Any other case
  (suppressed with a real profile, or not suppressed at all) calls
  `selectProfile(chosen, isSwitch && !suppressed)` as before. `ProfileSelector.tsx`
  renders an explicit disabled `—` option when `profileId === null` so the controlled
  `<select>` has a matching option to show.
- **Orphan replay**: the buffer is a single slot for the current document only. If it
  still holds a *dirty* snapshot for a document other than the one about to be hydrated
  (the user switched documents while a previous save was failing),
  `replayOrphanedSnapshot` takes over the pending retry (`cancelRetry()`) and gives that
  snapshot one direct replay attempt before it's overwritten, so a failing save doesn't
  silently lose edits just because the user moved on.
- **Startup replay** (`runInit`, wrapped by `initDocuments` behind an `initInFlight`
  guard so React StrictMode's double-invoked mount effect can't double-replay): a dirty
  buffered snapshot from a previous session is replayed first, the document list is
  fetched, a legacy pre-multi-document text blob is migrated into a new document if the
  list is empty, and finally the persisted `currentDocId` (or the most recent document)
  is opened.
- **Self-write detection before recovery** (`recoverSnapshot`): every 409/404 path — a
  live autosave conflict, an orphan replay, or a startup replay — funnels into this one
  function. Before creating a "recovered copy," it first fetches the server's current
  version of the same document (`getDocument(snapshot.docId)`). If the server's `text`
  already matches the buffered snapshot's `text`, the "conflict" is the client's own
  earlier write landing after the client itself gave up on the request (the same
  aborted-`beforeunload`-PUT race the no-op guard above targets, for the case where a
  real edit *was* pending, not just a no-op) — there is nothing to recover. The function
  clears the buffer, refreshes the document list, and hydrates the server's version in
  place (respecting `skipRecoveryHydrate` and an is-this-still-the-open-document check),
  without ever calling `createDocument`. Only when the server's text genuinely differs
  (or a 404 means the document is gone server-side) does the original recovered-copy
  path run: a new document named via `docRecovered(name)`, seeded with the buffered
  content, while the original id (if it still exists) is reloaded from the server in
  place. Together with the autosave no-op guard, this closes the reload-duplication bug
  end to end — the guard stops the redundant write from happening in the common case,
  and this check stops a redundant write that *does* still race from spawning a
  duplicate.

### Folder state, lifecycle, and error paths

`store.folders: Folder[]` and `store.docFoldersCollapsed: number[]` are the two pieces
of folder-related state; both are plain zustand fields with no derived/memoized layer —
`groupDocuments` (above, in `DocumentSidebar.tsx`) recomputes the folder/ungrouped split
from `documents` + `folders` on every render instead of maintaining a third synced copy.

- **`refreshFolders()`** (`documents.ts`) is the folder analogue of `refreshDocuments()`:
  `GET /api/folders` → `store.setFolders`, with a fetch failure setting the same
  `docListError` flag the document list uses (there is one combined retry banner, not
  a separate one per list) rather than a folder-specific error state. `runInit()` calls
  it once, right after the document list fetch succeeds and before the empty-list/legacy-
  migration branch — so folders are populated before the first render whether the
  startup path ends up creating a document, migrating legacy text, or opening an
  existing one. It is *not* called on the offline path (`listDocuments()` throwing):
  an offline boot hydrates from the buffer only and skips folders entirely, so a
  document opened while offline is never shown inside a folder group in that session,
  even if the buffered document has a `folder_id`.
- **Lifecycle verbs** (`addFolder`, `renameFolderById`, `removeFolder`,
  `moveDocumentToFolder`, all in `documents.ts`) patch `store.folders`/`store.documents`
  in place from each call's response rather than re-fetching:
  - `addFolder`/`renameFolderById` splice the API's returned `Folder` into
    `store.folders` and re-sort client-side (`sortedByName`, locale-aware
    `localeCompare` — mirrors the backend's `COLLATE NOCASE` ordering but is applied
    again here since a rename can change sort position without a full refetch).
  - `addFolder` and `renameFolderById` deliberately **rethrow** their errors instead
    of swallowing them: their callers (`NewFolderInput`'s `commit` and `FolderGroup`'s
    `commitRename`) need to distinguish a 409 (keep the input open, show `.conflict`)
    from anything else (set `docListError`, close the input). The other folder verbs
    funnel failures into `docListError` themselves.
  - `removeFolder` does not do in-place patching — deleting a folder changes which
    *documents* are grouped where (its members drop to ungrouped server-side), so it
    re-fetches both lists (`refreshFolders()` then `refreshDocuments()`) rather than
    trying to reconstruct the new grouping from the delete response alone.
  - `moveDocumentToFolder` patches only the moved document's `folder_id` in
    `store.documents` from the move response — cheaper than a full refetch since a
    move never changes any other document or folder. On failure it does not rethrow
    (unlike `addFolder`): a 422 means the target folder vanished meanwhile, so it
    re-fetches both lists (`refreshFolders()` then `refreshDocuments()`) to drop the
    stale entry from the submenu; any other error sets `docListError` instead. Either
    way the document's `folder_id` is left untouched, since the in-place patch above
    only runs after the API call resolves.
  - `createNewDocument(folderId?)` passes `folder_id` straight through to
    `POST /api/documents` when given, so "new document here" (the folder's ⋯ menu)
    creates already-grouped instead of creating ungrouped and then moving.
- **`folder_id` never rides the autosave payload.** `collectSnapshot()`/`flush()`
  (`autosave.ts`) and `DocumentUpdate`'s `content`/`settings` shapes have no `folder_id`
  field — organizing a document into a folder is exclusively a sidebar action through
  `moveDocumentToFolder` → `POST /api/documents/{id}/move`, never a side effect of the
  editor's save loop. This mirrors the backend split between `update_document` (revision-
  guarded) and `set_folder` (revision-free, see `docs/backend-architecture.md#folders`):
  the frontend simply never gives the autosave path a `folder_id` to send.
- **Error paths**: a failed `renameFolderById`/`removeFolder` rejects out of its
  promise; each call site (`DocumentSidebar.tsx`) catches it and sets `docListError`,
  surfacing the existing retry banner rather than a bespoke per-action error UI.
  `moveDocumentToFolder` is the exception — it handles its own failures internally
  (both submenu call sites just fire-and-forget it) so the one spot covers both: a 422
  (the target folder was deleted meanwhile) re-fetches folders and documents so the
  stale submenu entry disappears, while any other failure sets `docListError`. A failed
  move in particular leaves the document where it was — there is no optimistic
  client-side move that would need rolling back, since `moveDocumentToFolder` only
  patches state after the API call resolves. `renameFolderById`'s inline rename input
  mirrors `NewFolderInput`'s 409 handling: a duplicate name keeps the input open with
  `.conflict` styling instead of closing it into the generic error banner.

### Per-folder defaults

Phase 3 lets a folder carry optional defaults — language, profile, domains, LLM
provider/model/tier, and the auto-flag — applied when a document is created inside it
(the backend side: `docs/backend-architecture.md#per-folder-defaults`). `Folder` (`src/api/client.ts`)
now extends a `FolderDefaults` interface with the same seven optional fields the backend
stores; `store.folders` carries them with no separate fetch.

- **`applyFolderDefaults(payload, folder)`** (`documents.ts`) is an exported pure helper —
  unit-tested in isolation — that overlays a folder's set defaults onto a
  `DocumentCreatePayload` already built from the current header state. It's a no-op if
  `folder` is `undefined` (top-level "+ New document" never resolves a folder, so it's
  unaffected — current header state, as always). Each field applies independently, only
  if its default is non-`null`:
  - `default_language` → `payload.language`, with one cross-language guard: if the
    folder's language default differs from the header's language *and* the folder has no
    `default_profile_id` of its own, `payload.profile_id` is forced to `null`. Without
    this, a header profile selected for the *current* language would otherwise leak onto
    a document created with a different default language, where that profile doesn't
    even belong — the folder's own profile default (if set) always takes precedence and
    is applied normally right after.
  - `default_profile_id` → `payload.profile_id` directly (applied after the
    cross-language guard above, so a folder that sets both a language and a profile
    default always ends up with that exact pair, never cleared by the guard).
  - `default_domain_ids` → `payload.domain_ids`, applied whenever the folder's value is
    non-`null` — including `[]`, which is a real "default: no domains", distinct from
    `null`'s "no default, keep the header's domains."
  - The LLM provider/model/tier triple is treated as **one unit**: if *any* of the three
    folder fields is set, all three overwrite the payload's provider/model/tier together
    (mirroring the header's own pin-vs-tier selector, which never lets the three drift
    independently).
  - `default_llm_auto` → `payload.llm_auto` independently of the LLM triple (it's a
    separate field on both `documents` and the folder defaults).
- **`createNewDocument(folderId?)`** looks up the target folder in `state.folders` (only
  when `folderId` is given — the plain "+ New document" path passes `undefined` and never
  looks one up) and passes it through `applyFolderDefaults` before calling
  `apiCreateDocument`. `POST /api/documents` itself is unchanged — this is pure
  client-side payload construction against folder objects already in the store. After
  creation, `hydrateFromDocument` loads the returned document as usual, so the header
  immediately reflects the folder-defaulted values with no special-casing beyond the
  overlay itself.
- **`saveFolderDefaults(id, defaults)`** (`documents.ts`) calls
  `PUT /api/folders/{id}/defaults` and splices the returned `Folder` into `store.folders`
  in place (by `id`), the same in-place-patch pattern as `addFolder`/`renameFolderById`.
  It rethrows on failure rather than swallowing — the dialog (below) needs the error to
  show inline and keep itself open, not fall through to the generic `docListError` banner.
- **`FolderDefaultsDialog.tsx`** (new component, opened from a "Folder defaults…" entry
  in the folder's ⋯ menu in `DocumentSidebar.tsx`, alongside "New document here" /
  rename / delete) reuses the header's selector building blocks against a local `draft:
  FolderDefaults` state seeded from the folder's current values:
  - **Profile-requires-language coupling**: the profile `<select>` is `disabled` whenever
    `draft.default_language === null`, and its options come from `getProfiles(lang)` for
    the currently-drafted language (re-fetched via an effect keyed on `lang`, cleared to
    `[]` while `lang` is `null`). `withLanguageDefault(draft, language)` — a second
    exported pure helper — is the one place a language change is applied: it always sets
    `default_language`, and drops `default_profile_id` back to `null` unless the language
    is unchanged from the draft's current one, so picking a *different* language (or
    clearing it to "no default") always resets the profile choice rather than carrying a
    now-mismatched profile forward. This mirrors the backend's enforced invariant (profile
    default ⇒ language default) on the client side, before a save attempt can ever trip
    the 422.
  - **Domains**: a checkbox toggles between `null` ("no default", the list hidden) and
    `[]` ("default: no domains", the list shown with everything unchecked) — the same
    NULL-vs-empty-list distinction the backend preserves through pruning.
  - **LLM selector**: mirrors the header's tier-vs-pinned model — `pinned` is derived as
    `default_llm_tier === null && default_llm_provider !== null`, and the `<select>` shows
    a synthesized "pinned" option (labelled via `m.tierPinnedOption`) only while pinned,
    alongside the normal tier list and a "no default" option. Choosing a tier clears both
    provider and model; choosing "no default" clears all three.
  - **"Take from current document"** (`defaultsFromHeader`, a third exported pure helper)
    snapshots the live header/store state into a `FolderDefaults` in one click: language,
    profile id, and domain ids are copied as a concrete set list (never `null` — "take
    from current" always produces *some* default, that's the point of the button), the
    LLM triple follows the header's own pin-vs-tier shape, and the auto-flag becomes an
    explicit `true`/`false`. **This button is the only way a pinned LLM selection (or any
    concrete value) enters the draft "from scratch"** — the dialog's own controls only
    ever move between the tier list and "no default"/"no domains"; a provider/model pin
    can't be composed by hand in the dialog UI, matching the header's own pinning being an
    Advanced-panel action, not a plain selector one.
  - **Save/cancel**: Save calls `saveFolderDefaults`, closing the dialog on success;
    Cancel discards the draft untouched. A save failure (network, or the 404 from the
    folder having been deleted while the dialog was open) sets an inline error and leaves
    the dialog open rather than closing or refreshing the folder list — the constrained
    UI can't actually produce a 422 (the language/profile coupling above and the
    domain/LLM controls only ever construct valid combinations), but the dialog shows any
    error the same inline way regardless, as defense in depth.
- **i18n**: nine new keys (`folderDefaults`, `folderDefaultsNone`,
  `folderDefaultsTakeCurrent`, `folderDefaultsAuto`, `folderDefaultsAutoOn`,
  `folderDefaultsAutoOff`, `folderDefaultsSave`, `folderDefaultsCancel`,
  `folderDefaultsError`) across all seven locale catalogs, checked by the existing i18n
  parity test alongside every other message key.

### Per-document header settings and persistence

Each document carries its own `language`, `domain_ids`, `llm_provider`/`llm_model`/
`llm_tier`/`llm_auto`, and `profile_id` — the entire header configuration travels with
the document rather than being global, so switching documents can switch language and
LLM setup without a separate "per-document settings" UI. See [State
management](#state-management) above for what persist v2 keeps globally
(`uiLocale`, `lastProfileByLanguage`, `rulesCollapsed`, `currentDocId`,
`docSidebarCollapsed`) versus what now lives per-document on the backend. The one
remaining piece of document content in localStorage is the write-through buffer
(`fabulous-writing-doc-buffer`, above) — a cache of the *currently open* document only,
never a second source of truth for the list.

## Internationalization

The UI ships seven locales (`i18n/{en,de,fr,es,it,ja,zh}.ts`) — independent of the
seven *checked* languages, though the sets coincide. The effective locale is the
user's explicit choice or the browser preference (`detectLocale`, primary-subtag
match). Components call `useMessages()`; non-React code calls `currentMessages()`.
Catalog entries are plain strings or functions (for counts/parameters);
`interpolate()` splices React nodes into translated templates. A vitest test asserts
key equality across all catalogs, so a missing translation fails CI.

## API client

`api/client.ts` is the only module that talks to the network: small typed wrappers
around `fetch` for every endpoint, and `subscribeCheck()` wrapping an `EventSource`
for the SSE stream (returns an unsubscribe function; the `done` event and errors both
close the connection). The request/response types are defined in `types.ts` and match
the backend's pydantic models field-for-field — the shared contract is structural, not
generated.

## Testing and tooling

- **Unit tests** (`npm test`, vitest) sit next to the code: scheduler, equivalence,
  finding offset mapping, profile dirty logic, i18n catalogs, grouping/severity/source
  helpers, the store. Everything with logic is a plain module and tested without
  rendering components.
- **Lint/build**: `npm run lint` (oxlint), `npm run build` (tsc + Vite) — both CI
  gates.
- **Coverage**: CI runs vitest with `--coverage` (v8 provider); `vite.config.ts` counts
  every file under `src/` (not just what tests import), so untested components lower the
  number honestly. `scripts/ci-summary.mjs` renders test counts, failures, and the
  coverage total onto the run's Summary page; the junit XML and HTML coverage report
  are uploaded as run artifacts. On pushes to `main` the workflow publishes the line
  percentage as shields.io endpoint JSON on the orphan `badges` branch for the README
  badge.
- **Screenshots**: `npm run screenshots` (`scripts/capture-screenshots.mjs`,
  playwright-core against the running dev servers) regenerates the README images.
