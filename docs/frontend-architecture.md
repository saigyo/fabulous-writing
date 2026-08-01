# Frontend architecture

The frontend is a React 19 + TypeScript single-page app built with Vite. It has three
main ingredients:

- **CodeMirror 6** for the editor — and, less obviously, as the *source of truth for
  finding positions* (a CodeMirror `StateField` keeps spans correct while the user
  keeps typing);
- **zustand** for application state (one store; a small per-user preference slice is
  persisted by an explicit layer, not the persist middleware);
- a thin typed **API client** over `fetch`, including its own hand-rolled SSE reader
  for the check stream (`VITE_API_URL`, default `http://localhost:8000`).

There is no router; five views (editor, rules, terminology, profiles, admin) are
switched by a store field, and all five sit behind a **login gate** (see
[Authentication](#authentication)) — the app requires a signed-in caller as of M2. The
fifth, [admin](#admin-view-m6), carries a second gate on top (`is_admin`) and is a
late M6 addition. The editor workspace is special-cased: it is hidden (`hidden` attribute)
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
├── api/client.ts             # typed fetch wrappers, Bearer attachment, fetch-based SSE reader
├── state/
│   ├── store.ts               # the zustand store (single source of app state)
│   ├── prefsStorage.ts        # localStorage I/O: per-user pref blobs, token key, legacy-key cleanup
│   └── prefsPersistence.ts    # PREFS_DEFAULTS, loadUserPrefs, write subscriber (initPrefsPersistence)
├── auth/
│   ├── session.ts             # login/logout/expireSession/restoreSession, generation counter
│   ├── policy.ts               # tierAllowed/providerAllowed/modelAllowed/hasFeature/llmDisabled
│   ├── LoginGate.tsx          # renders LoginForm while anonymous, children once authStatus is ok
│   ├── LoginForm.tsx          # email/password form, posts to login()
│   └── AccountMenu.tsx        # signed-in email, password-change dialog (B3), log out
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
├── ui/
│   ├── Dialog.tsx              # accessible modal on native <dialog> (B3) — see Dialogs (B3)
│   └── ConfirmDialog.tsx       # Dialog's Cancel/danger-confirm face
├── rules/                     # rule catalog view + per-profile toggles
├── terminology/               # domain/term management view; terms edit in place
│                              # (row edit mode shares TermFieldCells with the add
│                              # row; drafts/parsing in termTable.ts), domains
│                              # rename inline via ✎ or double-click
├── admin/                     # AdminView.tsx: user list/create/row-edit, is_admin-gated (M6)
└── i18n/                      # 7 UI locales, hooks, interpolation
```

## State management

`state/store.ts` defines one zustand store. Four kinds of state live there:

- **Auth** — `token` (persisted in its own key (`prefsStorage.ts`), read once at store
  creation), `user` (never persisted — re-fetched via
  `GET /api/auth/me` on every fresh page load instead, so a stale cached profile can
  never diverge from what the server currently thinks is true), `authStatus`
  (`'unknown' | 'anonymous' | 'authenticated'`, what `LoginGate` renders off),
  `sessionExpired` and `restoreFailed` (which notice, if any, the gate/login form
  shows). See [Authentication](#authentication) below.
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

Persistence is no longer a `persist` middleware wrapping the whole store; it's an
explicit layer (`state/prefsStorage.ts`, `state/prefsPersistence.ts`, B1, #34) built
around three localStorage keys. The token lives alone in `fabulous-writing-token`,
read once at store creation (see Auth above). Each signed-in user gets their own
preference blob, `fabulous-writing-settings:<user.id>`, written in the
zustand-persist-compatible envelope `{"state": {...}, "version": 2}` — chosen so a
future return to the middleware wouldn't need a storage-format migration, though
nothing today migrates an old-format blob; a version mismatch is just treated as
absent and defaults apply. The pre-B1 single blob that mixed one shared token with
the last user's preferences, `fabulous-writing-settings`, is deleted once at boot and
never read again. A blob holds exactly six fields — `uiLocale`,
`lastProfileByLanguage`, `rulesCollapsed`, `currentDocId`, `docSidebarCollapsed`,
`docFoldersCollapsed` — and nothing else: `token` and `user` are never part of it,
`user` being re-fetched via `GET /api/auth/me` on every load rather than cached (see
Auth above).

`loadUserPrefs(userId)` applies the signed-in user's stored fields over
`PREFS_DEFAULTS` (the same six-field slice of `INITIAL_DATA`) in one atomic
`setState`. Landing defaults and blob together in a single step is what closes the
#34 leak: a user with no blob of their own gets exactly the defaults, never a value
left behind in memory by whoever was signed in before. A write subscriber
(`initPrefsPersistence()`, registered once from `main.tsx`) replaces the old
`partialize`: it runs on every store change but writes only past two guards — the six
pref fields must actually have changed by reference (an identity check, safe because
their setters always produce new values, and cheap enough to skip high-frequency
fields like `docWords`/`docChars` on every keystroke) and `user` must be non-null.
That second guard is why an ordering invariant runs through `auth/session.ts`: every
site that bulk-resets or bulk-loads preference fields must null `user` first, or the
subscriber would see the reset/loaded values with a still-live `user` and commit them
into the wrong namespace. `login()`'s user-change branch, `logout()`,
`expireSession()`, and `runRestore()` all carry it — the first three null `user`
*before* `resetSessionState()`, and `runRestore()` calls `loadUserPrefs()` before
`setAuth()` makes the restored user live. One consequence is by design, not omission:
preference blobs survive `logout()`, `expireSession()`, and a user-switching login
untouched — only the token dies with the session, so a returning user finds their
locale, current document, and collapse state exactly as they left them.

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

## `is_global` affordances and the domains-fetch guard

M3 gave the backend's `profiles` and `domains` tables a nullable `owner_id`: a row with
`owner_id NULL` is **global** — always a seeded built-in (Standard, the example
profiles, "Product docs"), never something created through the API: both create
endpoints always write `owner_id=user.id`, even for an admin caller, so a startup
seeder is the only path to a global row. A global row is visible to every account but
mutable only by an admin (see
`docs/backend-architecture.md#ownership`). The frontend's job is narrower than the
backend's: it never sees `owner_id` at all, only the derived `is_global: boolean` both
`Domain` and `Profile` (`types.ts`) now carry, and it must render read-only affordances
for a non-admin viewing a global row rather than let a doomed mutation reach the API
and 403.

**`TerminologyView.tsx`**: `isAdmin` comes from the store; each domain computes
`editable = !domain.is_global || isAdmin`, which gates the rename (✎) and delete (✕)
buttons and the double-click-to-rename handler — a non-admin simply has no way to
reach a mutation on a global domain. A `<span class="global-badge" title="…">Built-in
</span>` renders immediately after the domain name whenever `domain.is_global` is true
(admin or not — the badge states a fact about the row, not a permission the current
viewer lacks). `TermTable` takes the whole `Domain` (not just its id) plus a `readOnly`
boolean derived the same way, which hides the add-term row and every per-term ✎/✕ cell
for a non-admin on a global domain's term list.

**`ProfilesView.tsx`**: each `ProfileCard` computes `readOnly = profile.is_global &&
!isAdmin` and applies it twice, deliberately redundantly — **belt and buckle**:
`disabled={readOnly || …}` on every control that can reach a save (name input, domain
multi-select, tier buttons, the pin/clear-pin controls, provider/model selects,
rule-pack chips, both textareas) is the buckle; a `guardedSave` wrapper that
early-returns before calling the real save whenever `readOnly` is true is the belt
behind it, so even a control that somehow bypassed its own `disabled` attribute still
cannot mutate a global profile it has no business touching. The delete (✕) and reset
(↺) buttons don't go through `onSave` at all, so they are hidden entirely
(`!readOnly && …`) rather than merely disabled. The same `global-badge` span (mirroring
`TerminologyView`'s) renders beside the profile's name input whenever `profile.is_global`
is true.

**CSS**: `.global-badge` (`App.css`) mirrors the pre-existing `.case-badge` rule
byte-for-byte (small bordered, muted, uppercase pill) rather than inventing a new visual
language for "this is special." One specificity fix was needed: `.domain-row span`
already sets `flex: 1` for every child span in a domain row, which — being a
class+element selector — beats a bare `.global-badge` class selector regardless of
source order, and would stretch the badge across the whole row. `.domain-row
.global-badge { flex: none }` (a class+class selector, which wins) overrides it. Two new
i18n keys, `globalBadge`/`globalBadgeTitle`, are defined once per locale across all
seven catalogs.

**The domains-fetch guard**: `getDomains()` populates `store.domains` from two call
sites, and both capture `sessionGeneration()` before the fetch and check it again before
writing — see this document's [Authentication](#authentication) section
("Purge-on-user-change") for why this uses the **auth** counter rather than the document
one — but the two sites are not identical, and are documented separately below rather
than as one symmetric pair:

- `App.tsx`'s `Header` mount effect guards **both** paths: the resolve writes
  `setDomains(domains)` only if `sessionGeneration()` still matches, and the `.catch`
  fallback writes `setDomains([])` under the same check, so a session turnover discards
  a late rejection exactly like a late success.
- `TerminologyView.tsx`'s `refreshDomains()` has only a `.then(...)` — no `.catch` at
  all. Its success write is guarded the same way as `Header`'s, but a rejection is
  simply left unhandled: nothing resets `store.domains` on that path, guarded or not,
  because there is no fallback write there to guard.

Before M3, domains were shared, unowned data, so a stale write here was harmless by
construction — the in-code comment on `App.tsx`'s effect used to say exactly that ("no
generation guard needed"). M3 made that reasoning obsolete the moment domains gained an
`owner_id`: an unguarded write landing after a user change would show the *previous*
account's private domain names to whoever is now logged in. The stale comment was the
trigger for a wider audit (`grep -rn "getDomains("` and `grep -rn "No generation guard"`
across `frontend/src`) that confirmed these were the only two call sites and the only
stale comment of that shape in the tree.

Both mount effects also re-run on more than just mount: each depends on `store`'s
`authGeneration` counter (`state/store.ts`) — bumped only by `login()` on every commit,
same-user re-login included (`auth/session.ts`) — so a fetch still in flight when the
password-change flow's silent re-login lands gets discarded by the `sessionGeneration()`
check above exactly as before, but a **replacement** fetch is issued right behind it
instead of leaving the picker empty for the rest of the session (Copilot round-9
U1/U2). `authGeneration` is deliberately not bumped by `logout()`/`expireSession()`:
both already unmount these components via `LoginGate`, so re-firing on the way to a
logged-out state would only fire fetches nothing is listening for.

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
  `hooks/useDismissOnOutsideClick.ts` (`ref`, `open`, `onDismiss`), replacing two
  duplicated outside-click listeners and two mouse-leave handlers with one shared
  behavior (exercised indirectly through the e2e baseline; no direct unit test, per
  the no-component-test convention).

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
management](#state-management) above for what the per-user preference blob keeps
(`uiLocale`, `lastProfileByLanguage`, `rulesCollapsed`, `currentDocId`,
`docSidebarCollapsed`, `docFoldersCollapsed`) versus what now lives per-document on the
backend. The one
remaining piece of document content in localStorage is the write-through buffer
(`fabulous-writing-doc-buffer`, above) — a cache of the *currently open* document only,
never a second source of truth for the list.

## Dialogs (B3)

`ui/Dialog.tsx` and `ui/ConfirmDialog.tsx` give the app one accessible modal
primitive, replacing what used to be three different ad hoc idioms: a bespoke
`.dialog-overlay` div (`FolderDefaultsDialog.tsx`), a second `view` state
drawn inside an existing popover (`AccountMenu.tsx`'s password change), and
the blocking `window.confirm` (`DocumentSidebar.tsx`'s delete confirmations).
None of those three remain.

- **`Dialog`** wraps the native `<dialog>` element. `showModal()`, called
  once from a mount-only effect, makes the rest of the page inert — the
  platform is the focus trap, not a hand-rolled one — and Escape arrives as
  the `cancel` event, which the component `preventDefault()`s and turns into
  a call to `onClose` rather than letting the element close itself: every
  dismissal path (Escape, backdrop, a button inside) funnels through
  `onClose` so the parent's mount/unmount stays the single source of truth
  for whether the dialog is open. Backdrop dismissal fires on **mousedown**
  (not `click`), checking both `event.target === dialog` (a click on the
  dialog's own padding also targets the `<dialog>` element itself, not a
  descendant) and the click coordinates against the panel's bounding rect —
  mousedown rather than click so a drag that starts inside the panel and
  releases outside doesn't dismiss it. Body scroll is locked for the
  dialog's lifetime (`document.body.style.overflow`, saved and restored on
  unmount), and focus returns on close to `returnFocusTo` if the caller
  passed one, else whatever was `document.activeElement` when the dialog
  mounted — `returnFocusTo` exists for callers whose opener is already
  unmounted by the time the dialog appears (a popover menu item, gone once
  its own popover closed). The `<h2>` title is wired to the element via
  `aria-labelledby` (a `useId()`-generated id). Styling is one shared rule,
  `dialog.app-dialog` plus `::backdrop` (`App.css`), that every dialog's own
  class (`.confirm-dialog`, `.account-password-dialog`,
  `.folder-defaults-dialog`) layers onto.
- **`ConfirmDialog`** is `Dialog`'s confirm face: a message plus Cancel /
  danger-styled confirm, using generic `dialogCancel`/`dialogConfirm` i18n
  keys rather than per-caller strings. Cancel — not the destructive action —
  carries `autoFocus`, so a stray Enter on a just-opened dialog can never
  destroy anything; Escape and backdrop both cancel via `Dialog`'s `onClose`.
  `DocumentSidebar.tsx` adopted it for both its document- and folder-delete
  confirmations, each passing `returnFocusTo` as the ⋯ menu button that
  opened the now-closed menu.
- **Change-password** (`auth/AccountMenu.tsx`) used to be a second `view`
  state (`'menu' | 'password'`) drawn inside the same account popover as a
  drill-in. It is now its own `Dialog` (`account-password-dialog`), opened
  by the popover's "Change password" button — which also closes the popover
  — and given `returnFocusTo={badgeRef}`, since the button that opened it
  belongs to a popover already gone by the time focus needs to return. All
  of M2's completion guards (the `sessionGeneration()`-gated silent
  re-login, abandon-on-turnover at both await points) are unchanged; B3
  changed only the presentation, not the async lifecycle described under
  [Authentication](#authentication) below.
- **`FolderDefaultsDialog.tsx`** was refactored onto the same `Dialog`
  primitive; its previous bespoke `.dialog-overlay` div (with its own
  mousedown-on-self-only dismissal check) is gone, replaced by
  `folder-defaults-dialog` layered on `dialog.app-dialog` the same way every
  other dialog in the app is.

**Button font sizing (B11, #52).** `index.css` is the single global home for the
form-control font reset — `input, select, button { font: inherit }`, loading before
`App.css` so nothing needs to repeat it — meaning an unsized button always inherits
its parent's font-size, not a UA default. Surfaces that need a different size set it
on their own class rather than adding a second element-level rule. `ConfirmDialog`'s
Cancel/confirm row is the one surface that does: `.confirm-dialog-buttons button`
sets `font-size: 0.85rem`, since the dialog body's smaller text would otherwise leave
those buttons inheriting the root's 1rem.

**Theme root (B18, #63).** `index.css` sets `color-scheme: light` on `:root`, then
flips it to `color-scheme: dark` inside the `prefers-color-scheme: dark` media query
alongside the rest of the dark palette. `color-scheme` is what makes UA form-control
chrome, scrollbars, and the page canvas follow the app's theme — and it's why buttons
get no author color reset here: system colors like `ButtonText` resolve per
`color-scheme`, so native button text stays readable in both themes without any CSS
from this app. The same two blocks define the token set the rest of the app draws
from: `--bg`, `--panel`, `--border`, `--text`, `--text-dim`, `--accent`,
`--accent-soft`, `--bg-raised` (a "lifted" surface for pills and code blocks,
given a real value in both themes rather than a light-only fallback), and
`--held-back` (amber for held-back suggestions, #65: light uses amber-700,
dark uses amber-500 for WCAG AA contrast on both `--panel` and hover wash). B18's
classification rule for anything touching color: surface chrome — borders, panel and
raised backgrounds — uses these tokens; semantic colors (danger, severity, category
palettes) stay literal — though a semantic hue may still need a per-theme contrast variant where a literal fails WCAG on one theme's surfaces (see the held-back amber, #65) — since their meaning is independent of theme and re-deriving
them per `color-scheme` would blur it. `.advice-note` and `.pinned-note` (dim text),
`.tier-option` (border and background), and `.admin-users` (row borders) were the five
declarations in `App.css` migrated onto tokens under this rule; `.tier-option.selected`'s
accent color stays literal as a saturated selected-state fill carrying white text — the same exemption the danger fill takes.

### Editor theming (#66)

CodeMirror does not follow `color-scheme`: its chrome is selected by the
`EditorView.darkTheme` facet, which `basicSetup` leaves false.
`src/editor/theme.ts` owns the fix: a `Compartment` that is empty in
light mode (light editor pixels are untouched) and in dark mode holds
two extensions. First, a `dark: true` theme — flipping the facet
activates CM's built-in dark chrome (caret, selection, active line stay
on CM's proven base-dark values) and token-aligns only the gutter
(`--panel`/`--text-dim`, active-line gutter `--bg-raised`; no border — CM's
dark base draws none). Second, a `themeType: 'dark'` highlight style built
from `defaultHighlightStyle.specs` with exactly two color substitutions
(`tags.meta` → `--text-dim`, the `tags.url` entry → `--accent`): `basicSetup`
registers the default style as a *fallback*, which any main highlighter
replaces wholesale — spreading the specs is what keeps bold/italic/heading/link
decorations alive in dark mode. `watchTheme` follows live OS scheme changes
via `matchMedia`; `Editor.tsx` runs its cleanup on unmount. `@codemirror/language`
and `@lezer/highlight` became direct dependencies for `HighlightStyle`/
`syntaxHighlighting` and `tags`.

## Authentication

M2 puts the whole app behind a login gate — every backend feature router now requires
a caller (see `docs/backend-architecture.md`'s
[Authentication](backend-architecture.md#authentication-and-user-accounts)). M2 was
enforcement, not ownership: every document, folder, profile, and terminology domain was
still shared across every account. **M3 (this one) is what scopes data to the caller who
created it** — see [`is_global` affordances and the domains-fetch
guard](#is_global-affordances-and-the-domains-fetch-guard) above and
`docs/backend-architecture.md`'s [Ownership](backend-architecture.md#ownership) section
for the full model.

**The shell** (`GateShell`, `auth/LoginGate.tsx`) wraps every visible pre-auth state —
the login form and the connection-failed retry card; `'unknown'` renders nothing, so
there is no third state to wrap — in a split layout (B4, #37): `.login-brand` (the
wordmark plus `loginTagline`, an i18n string) beside `.login-pane`, which hosts the
unchanged `.login-card` content. At >=720px the two sit side by side; at <=719px
`.login-split` stacks them, brand pane on top with the gradient's rounded corner
flipped to match. `LoginGate` keeps the `authStatus` branching — which state renders
at all — while `GateShell` is pure layout, applied identically to both branches that
render something.

**The gate** (`auth/LoginGate.tsx`) renders `LoginForm` only while `authStatus` is
`'anonymous'`, and the app (children) only once it is `'authenticated'`. While
`'unknown'` it renders **nothing** (`LoginGate.tsx:76`) — deliberately, and this is the
reason that state exists: showing the login form during the restore round-trip would
flash it at an already-authenticated user on every reload, and mounting the app would
fire its mount effects unauthenticated. `authStatus` starts `'unknown'`;
`restoreSession()` (called once at mount) resolves it before anything else renders. With no stored token,
`restoreSession()` returns immediately without calling the API at all — a first-time
anonymous visit makes **zero** `/api/*` requests. With a stored token it calls `GET
/api/auth/me` — **exactly one** request — and sets `authStatus` from the result: `ok`
→ `'authenticated'`, a 401 → `'anonymous'` (via `expireSession()`, which also shows the
session-expired notice), anything else (a dropped connection, a 500) → leaves
`authStatus: 'unknown'` and sets `restoreFailed`, deliberately **not** clearing a
perfectly good token over a backend hiccup.

**Where the Bearer header is attached.** `api/client.ts` builds `Authorization: Bearer
<token>` in exactly one place, `authHeader()`, reading `useStore.getState().token` at
fetch time (not captured earlier — an in-flight request that turns stale during a
session change still carries the token of the session that sent it, never a token
that arrived after). Both `requestWithOptions()` (every plain JSON call) and the SSE
reader (below) call `authHeader()` — the string is assembled once, not grown a second
copy anywhere headers are built. Any 401 response — from either path — is routed
through the same `handleUnauthorized()`, which calls the handler `auth/session.ts`
registers (`expireSession`) **only if the token that produced the 401 is still the
store's current token** — a straggler response from a session that has already ended
(logged out, or a fresher login already succeeded) must not tear down the session
that replaced it.

**The fetch-based SSE reader and why `EventSource` was replaced.** `EventSource` has no
way to attach an `Authorization` header — it is a browser API with a fixed request
shape, cookies only. Task 5 replaced it with a hand-rolled reader over
`fetch()` + `ReadableStream` + `AbortController`, using `eventsource-parser` only for
wire-format framing (chunk boundaries, `\r\n` vs `\n`, multi-line `data:` fields,
comments) — not for transport. This also fixed two behaviors a full SSE client would
have gotten wrong for a one-shot check stream: both alternatives considered reconnect
automatically (wrong — a finished or errored check must not silently resume), and one
of them treats only an HTTP 204 as a terminal signal, so a 401 from an expired token
mid-stream would have looped invisibly back into the same 401 handler instead of
ending the stream. The reader now checks `response.ok` itself before ever handing
bytes to the parser, so a 401 body (which `fetch()` resolves "successfully," unlike
`EventSource`, which would just silently fail to connect) is caught and routed to
`handleUnauthorized()` rather than parsed as zero events and treated as a quiet,
successful end of stream.

**Purge-on-user-change.** Two independent generation counters exist, guarding two
different kinds of in-flight work, and it matters that they are not the same counter.
`auth/session.ts` owns an auth counter (`sessionGeneration()`), bumped by **every**
session transition — `login()` on commit (`session.ts:30`), `logout()`, and
`expireSession()`. It has exactly one external consumer, `AccountMenu.tsx`'s
password-change flow, which captures it before the change request and compares it
after the 204, so a log-out or an unrelated expiry landing in that window abandons the
completion instead of writing a stale password-changed banner into whatever session is
current by then.

For the *second* window — a log-out landing while the silent re-login is itself in
flight — that flow deliberately does **not** compare the counter again, because a
successful `login()` bumps it, so an equality check there would abandon every normal
completion. It relies on `login()`'s returned boolean instead: `login()` returns
`false` without committing anything when the session moved while `postLogin` was in
flight.

`documents/autosave.ts` owns a separate document counter (`currentGeneration()`),
bumped by `invalidateDocumentWork()` — called from `logout()` and `expireSession()`,
again **never from `login()`**. This is the counter every in-flight document-affecting
operation captures at its start and re-checks before committing: the autosave push
itself (`documents/autosave.ts`), the document CRUD helpers (`documents/documents.ts`,
`documents/folders.ts`), and — as of M2's final review — the five header/view modules
whose async writes can feed the same open document (`App.tsx`'s per-document settings
subscription and profile-fetch effect, `header/ProfileSelector.tsx`,
`profiles/ProfilesView.tsx`, `rules/RulesView.tsx`). That is real coverage, not "every
in-flight async operation" — writes backed by data that is genuinely not
document-scoped (providers, languages, routing — nobody owns these, ever) commit
unconditionally through this counter, because there is nothing session-specific in
them to leak. **Domains moved out of that group once M3 gave them an owner.** A
domains fetch that resolves after the caller has changed is a real leak now (another
account's domain names landing in the new caller's UI), but it is not *document*-scoped
either — nothing about it belongs to the currently open document — so it is guarded by
the separate **auth** counter (`sessionGeneration()`, above) rather than this one: both
`App.tsx`'s `Header` mount effect and `terminology/TerminologyView.tsx`'s
`refreshDomains()` capture `gen = sessionGeneration()` before the `GET /api/domains`
call and only call `setDomains(...)` if `sessionGeneration() === gen` still holds — on
`Header`'s resolve *and* its `.catch` fallback, but `refreshDomains()` has no `.catch`
to guard in the first place, so its check applies to the resolve path alone; see
[`is_global` affordances and the domains-fetch
guard](#is_global-affordances-and-the-domains-fetch-guard) above for the full picture,
including why both effects also re-fire on a same-user re-login.

`login()` leaving the **document** counter alone is deliberate, not an oversight:
in-flight document work must survive a same-user re-login, which is exactly what the
silent re-authentication after a password change depends on — the token changes, but
the person, and the document they were editing, has not. The auth counter is bumped in
that same path, which is why the two are separate counters rather than one.

**Why `checking/cancelSlot.ts` exists.** `checking/` cannot import `sessionGeneration`
(or anything else) from `auth/session.ts` directly: `documents/hydration.ts` already
imports `cancelCheck` from `checking/controller.ts`, and `session.ts` already imports
from `documents.ts`, so a direct `controller.ts <-> session.ts` import would close the
cycle `controller -> session -> documents -> hydration -> controller` — not merely
untidy, but a crash at boot, since whichever of the two modules is reached second in
the dependency graph's depth-first evaluation finds the other's binding still in its
temporal dead zone. `checking/cancelSlot.ts` is a small, deliberately leaf module (it
imports from neither `controller.ts` nor `session.ts`, and nothing imports it back into
either) that `controller.ts` and `session.ts` both talk to instead of each other,
breaking the cycle. `checking/cancelSlot.test.ts` pins this: it exists to catch a
regression that re-closes the cycle before it reaches production and crashes the app
at boot.

`resetSessionState()` (called
by `logout()`, `expireSession()`, and by `login()` **only when the signing-in user's
id differs from the previous one**) shallow-merges `INITIAL_DATA` back over the store
— every data field, including the six preference fields, returns to its default *in
memory*. It never touches localStorage: a per-user preference blob is untouched by a
reset, and the write subscriber never commits the reset defaults over it, because
every caller runs `setAuth(null, null)` before calling it (the ordering invariant, see
[State management](#state-management) above) — the subscriber is silent while `user`
is null. Only `login()`'s user-change branch has anything to do next: it calls
`loadUserPrefs(user.id)` immediately after the reset, replacing the freshly-defaulted
in-memory fields with the incoming user's own stored blob, all still before
`setAuth(token, user)` makes `user` non-null again. `logout()` and `expireSession()`
have no next user to load for, so the reset defaults are simply what the anonymous
state shows until the next sign-in. The `only when the user differs` qualifier is
deliberate: Task 8's silent re-authentication after a password change signs the *same*
person back in, and must not discard their locale, current document, or collapse
state just because the token changed.
`discardForeignBuffer()` applies the same rule to the write-through document buffer
(`documents/buffer.ts`) — a buffer with no `ownerId`, or one belonging to a different
user, is discarded on login; a buffer belonging to the incoming user's own unsaved
work survives. `logout()` additionally cancels any in-flight check
(`cancelInFlightCheck()`, which the checking controller registers a handler for) and
invalidates pending document writes before clearing state, so a check or a save that
was mid-flight when the user logged out cannot land after the session that started it
is gone.

## Tiers and policy gating

M4 gives the backend a per-user-tier LLM policy and creation feature flags
(`docs/backend-architecture.md#tiers-and-llm-policy`), delivered to the
client on `GET /api/auth/me`'s `policy` field. The frontend's job is UI
gating only — disabling or hiding what the caller cannot use — never
enforcement; the server degrades or refuses regardless of what the client
sends.

**`auth/policy.ts` is the single gating source.** Every component that
needs to know "is this tier/provider/model/feature available to the
current user" calls one of its five pure functions
(`tierAllowed`/`providerAllowed`/`modelAllowed`/`hasFeature`/`llmDisabled`),
all built on `store.user.policy` (the `/me` response, `MeResponse` in
`api/client.ts`) — never on the `allowed` flags `GET /api/routing` and
`GET /api/providers` also carry. Those two API-level flags exist for other
consumers of those endpoints (a future non-browser client, or a script);
the frontend has its own client-side mirror of the same policy so gating
logic lives in one typed module instead of being scattered across whatever
component happens to render a tier/provider/model list. A `null` user
(session not yet restored) or a `null` policy dimension means unrestricted
— this is cosmetic parity with the backend's own `None`-means-unrestricted
`LLMPolicy`, not a separate decision.

**The `llm_tier` request field: who resolves what.** `POST /api/checks`
carries `llm_tier` (plus `llm_provider`/`llm_model` in pinned mode) built
by `checking/controller.ts#runCheck`. Two independent resolutions happen
before that request goes out, and they check different things:

- **Client: availability.** `checking/routing.ts#resolveModel` resolves
  the header's choice to a concrete provider/model — tier mode looks the
  tier up in the fetched routing table and fails explicitly
  (`{ok: false, reason}`) if the entry is missing or unavailable; pinned
  mode resolves the explicit pair. This has **nothing to do with policy**
  — it is the same routing-availability check that predates M4.
- **Server: policy.** `resolve_llm_selection` (backend) is what actually
  decides whether the requested tier/provider is allowed for this caller,
  degrading gracefully per spec §6.2 if not.

**Off-plan tiers deliberately bypass the client availability check** —
`runCheck` computes `offPlanTier = state.tier !== null &&
!tierAllowed(state.user, state.tier)` and, when true, still sends the
request (`wantLlm` short-circuits past `resolution.ok`) even if that
tier's own route happens to be locally reported unavailable: the server
will degrade an off-plan tier to a different one the client cannot
pre-compute, so blocking the request client-side would block the very
degradation §6.2 exists to perform. The client's own availability check
still applies normally to an *on-plan* tier — a client-visible outage is
still reported as `llmSkipped`, not silently retried against the server.

**`llmEffective` and the Sidebar notes.** `state.llmEffective:
EffectiveLlm | null` (`state/store.ts`) is set from each check response's
`effective_llm` (`result.effective_llm ?? null`) and cleared on every new
check/cancel. `sidebar/Sidebar.tsx` renders two independent notes off it:

- `llmEffective?.degraded && !llmEffective.skipped` — a `.llm-note` naming
  both the effective and originally-requested tier/provider/model
  (`m.llmDegraded(effectiveLabel(effective), effectiveLabel(requested))`):
  the check ran, just not with what was asked for.
- `llmEffective?.skipped === 'llm_unavailable'` — a `.llm-note` that
  branches on **why** the LLM phase didn't run at all, using `llmDisabled`
  to distinguish a policy floor from a server-side configuration gap:
  `llmDisabled(user) ? m.llmNotIncluded : m.llmSkippedServer` — the first
  reads as "your plan doesn't include this," the second as "the LLM check
  couldn't run" (a missing routing entry, an unconfigured provider), so
  the same skip code never shows a policy message to a caller whose policy
  had nothing to do with the skip.

**The floor hides `LlmSelector` entirely.** `llmDisabled(user)` (both
`policy.llm.tiers` and `policy.llm.providers` empty — the §6.2 floor, a
tier with no LLM access at all) makes `header/LlmSelector.tsx` return
`null` outright — after its hooks, so React's rules of hooks hold
regardless of which branch is taken — rather than rendering a
selector full of disabled options. `App.tsx`'s auto-check toggle button is
gated the same way (`{!llmDisabled(store.user) && <button ...>}`), since
toggling auto-LLM-checking is meaningless when the phase can never run.
Short of the floor, individual tier/provider/model options stay visible
but `disabled` (via `tierAllowed`/`providerAllowed`/`modelAllowed`, with an
`m.planSuffix` label) so a restricted caller can still see what exists,
just not select it.

**Feature-gated create affordances.** `hasFeature(user, 'custom_profiles')`
and `hasFeature(user, 'custom_domains')` gate the **creation** entry points
only, mirroring the backend's creation-only feature-gate scope
(`docs/backend-architecture.md#feature-gates-are-creation-only`):
`profiles/ProfilesView.tsx`'s `canCreate` hides the "+ New profile"
affordance; `terminology/TerminologyView.tsx`'s `canCreate` hides "+ Add
domain" and each domain's "+ Add term" row. Neither gate touches editing,
deleting, or viewing anything the caller already owns or any global row —
those stay governed entirely by the pre-existing `is_global`/`isAdmin`
ownership affordances (see [`is_global` affordances and the
domains-fetch guard](#is_global-affordances-and-the-domains-fetch-guard)
above), which are orthogonal to feature gating. `ProfilesView.tsx`'s
per-profile LLM controls (tier buttons, provider/model selects, the pin
button) are gated by **both** axes at once — `disabled={readOnly ||
!tierAllowed(...)}` and so on — `readOnly` (the M3 ownership check) and
the M4 policy check are combined, never one replacing the other, so a
non-admin viewing their own private but off-plan-tier profile still sees
the control disabled for the right reason.
`documents/FolderDefaultsDialog.tsx`'s quality-tier options apply
`tierAllowed` the same way (`disabled={!tierAllowed(user, tier)}` +
`planSuffix`); the dialog itself carries no creation gate, since editing a
folder's defaults is not a create action.

## LLM usage metering

M5 gives the backend a per-run ledger, a daily quota, concurrency caps, and
a size cap (`docs/backend-architecture.md#llm-usage-metering`). The
frontend's job, as with M4's policy gating, is display and UI-level
gating only — every limit is enforced server-side regardless of what the
client shows.

**`MeResponse.usage`/`limits` are the one display source (B6).** `GET
/api/auth/me` (`types.ts`) carries `usage: {label, windows: [{window,
used_percent}, ...]}` — there is no `budget` field; the backend never sends
an absolute number, only the rounded percentage — and `limits:
{max_document_chars, max_llm_document_chars, concurrent_llm_runs}` alongside
the M4 `policy` payload. No absolute credit numbers are reported locally —
the UI shows only the tightest window's percentage.

- **The quota indicator** (`App.tsx`): displays `{label}` + `{used_percent}%`
  for the tightest configured window (lowest remaining budget), hung as a
  compact caption below the Check/account buttons — absolutely positioned off
  `.header-controls`, right-aligned, the same treatment as the resolved-model
  caption below the `LlmSelector` (B10), so it never adds header height — and
  hidden entirely (like the selector itself)
  when `llmDisabled(store.user)` — showing a quota percentage for an account
  with no LLM access at all would be noise, not information. `tightestWindow`
  reduces `usage.windows` to `null` (hiding the whole indicator) when that
  array is empty — a defensive guard, not a reachable state for a logged-in
  user: every tier's `limits:` block must configure at least one
  `credits_per_{hour,day,week,month}` window (`_at_least_one_window`), and
  `_default_admin_limits()` supplies a day budget for the admin ceiling /
  no-`tiers:` fallback, so `windows` is never empty in practice. The `title`
  attribute (tooltip) and `aria-label` both list **every** configured
  window's percentage
  as `{windowName}: {percent}%` (separated by `·` in the tooltip, by `, ` in
  the aria-label) so screen readers and tooltips show the full per-window
  breakdown. There is deliberately **no at-limit styling** — the visual
  indicator is the percentage number, not a color change or warning icon.
- **The char-count dual thresholds** (`sidebar/Sidebar.tsx`): `docChars`
  (live character count of the editor buffer) is compared against **two**
  independent caps — `overLlm = docChars > user.limits.max_llm_document_chars`
  and `overDoc = docChars > user.limits.max_document_chars` — and the
  character-count line appends `charCountOverDoc` or `charCountOverLlm`
  (checked in that order, so hitting the smaller, request-level document
  cap always takes priority over the wider LLM cap note) when either fires.
  These are advisory only: the byte-budget middleware and the gate's size
  cap are what actually refuse a request.

**`skipNoticeText` (`checking/skipNotice.ts`) is the one home for skip
copy.** It maps an `EffectiveLlmReport.skipped`/`SuggestionResponse.skipped`
code to display text — `quota_exhausted` (B6: now means a credit window is
exhausted, no longer a run count) → `m.llmQuotaExhausted` (a plain string,
not a function call), `document_too_large`
→ `m.llmDocumentTooLarge(user?.limits.max_llm_document_chars ?? 0)`,
`llm_unavailable` → `llmDisabled(user) ? m.llmNotIncluded : m.llmSkippedServer`
(the M4 split), anything else/`null` → `null`. Both `sidebar/Sidebar.tsx` (the
check-time skip note, driven by `state.llmEffective`) and `checking/suggest.ts`
(the on-demand suggestion/rewrite error, falling back to `m.llmSkippedServer`
if `skipNoticeText` returns `null`) call this one function, so the sidebar note
and a suggestion's error text can never drift apart on wording — the window
percentages come from `/me` (`user.usage`), never from the report, which
carries only the code (a documented deviation from spec §6.4/§6.5 — see
`docs/backend-architecture.md`'s LLM usage metering section and the roadmap's
Cross-milestone interfaces).

**`refreshUser()` and its call sites.** `auth/session.ts#refreshUser()` is
a best-effort `/me` re-fetch so the quota indicator tracks reality after an
LLM run, guarded exactly like `runRestore()` (a session change mid-flight
drops the response; any failure is swallowed — freshness here is cosmetic,
the backend enforces the real limit). It cannot be called directly from
`checking/` without closing the same import cycle
(`controller -> session -> documents -> hydration -> controller`,
documented above under [Authentication](#authentication) for
`checking/cancelSlot.ts`) — `auth/refreshSlot.ts` is the matching
registration-slot leaf module (`setRefreshUserHandler`/`refreshUserNow()`)
that breaks it the same way.

`checking/controller.ts#runCheck` fires **two** refreshes per admitted LLM
check, not one — a single refresh cannot see both ends of a run. Whether a
check was admitted at all is decided once, right after `postCheck()`
resolves: `result.effective_llm` present with `skipped == null` (a skip
never reserves a ledger row, matching the never-refresh-on-skip rule
elsewhere — see `checking/suggest.ts`'s 429 branches below). That decision
is captured in a local (`admittedLlmRun`) and reused by both refresh sites,
rather than re-derived, so they can't drift apart.

- **Refresh #1, at admission**, immediately once the POST resolves:
  `reserve_llm_run()` inserts the ledger row at ADMISSION time — inside this
  same POST /check request/response cycle — and the usage windows are
  status-blind (every row counts toward its window regardless of status), so
  the window percentages have already changed the moment the POST resolved.
  But the row still carries the admission ESTIMATE, not the settled cost —
  gated on `gen === currentGeneration()` only (not `epoch`), since it must
  fire even if the same-session document switch that bumped `epoch` tore the
  subscription down before it was ever opened; a `gen` mismatch means the
  session itself ended, so refreshing would race the next session's own
  `/me` fetch instead.
- **Refresh #2, at settlement**, from the SSE subscription's `onDone`
  handler. This is not redundant with refresh #1: on an expensive model the
  settled cost can differ substantially from the admission estimate, and
  without this second refresh the indicator would lag one check behind —
  showing the old estimate until the *next* check happened to run. It is
  safe to treat `done` as settlement-visible because of a concrete backend
  ordering guarantee: in `backend/app/api/checks.py`'s LLM task, the
  `finally` block calls `reservation.finish(...)` (the ledger settle, to
  actual tokens) BEFORE `job.finish()` — the call that emits the `done` SSE
  event and unblocks the client's stream. So by the time this handler runs,
  the settled row is already committed; there is no race to lose. (Not
  `checker_error`: that event fires earlier in the same task, before
  settlement, so a refresh anchored there could still read the estimate.)
  This refresh only fires for a subscription that is still live for its own
  check (`currentCheckId === checkId`, the same guard `onResult`/`onProgress`
  use) and passes the same `admittedLlmRun`/`gen` checks as refresh #1.

**Detached subscriptions are the accepted gap.** If `cancelCheck()` (a
document switch) or a newer `runCheck()` tears the subscription down before
`done` ever arrives, no settlement refresh fires for that run — refresh #1
already landed the admission estimate, and the settlement delta (bounded by
one run's estimate-vs-actual difference) is picked up by the next natural
refresh: the next admitted check, a login, or a reload. This is the same
trade-off as before, just narrower in scope now that refresh #2 exists for
every run whose subscription survives to `done`.

`checking/suggest.ts`'s `fetchSuggestions`/`fetchRewrite` need no second
refresh: `postSuggestions()` is a single synchronous request/response with
no SSE leg, so settlement completes server-side before the response ever
returns — the existing single refresh (after a successful, non-skipped
response, and again in the `catch` block for any non-429 failure — a
provider error such as a 502 still settles its ledger row as `'failed'`
server-side, to actual tokens if the provider reported any, else to 0, since
a request-stage failure never reached the provider and so costs nothing) is
already settlement-accurate by construction. Never on a skip, since a skip
never reserved a ledger row, and never on a 429, since a rejected
reservation rolled back and consumed no credits.

**The 429 transient notice.** All three LLM-invoking call sites
(`controller.ts#runCheck`, `suggest.ts#fetchSuggestions`/`fetchRewrite`)
catch `HttpError` with `status === 429` before any other error handling and
show `m.serverBusy` ("Server busy — please retry shortly.") instead of a
generic failure message — resetting `checkPhase`/pending state back to idle
without touching auth in any way. This is spec §8's transient contract: a
429 means the server is busy right now, not that anything is wrong with the
request or the session, so it must never be treated as (or look like) an
auth event, and never sets `llmError`/`suggestError` to anything that reads
as a hard failure.

## Admin view (M6)

`admin/AdminView.tsx` is a fifth `activeView`, mounted in `App.tsx` behind
`activeView === 'admin' && isAdmin` — the `&&` is structural, not cosmetic:
a non-admin session's `App.tsx` never renders the component at all, so it
never issues an `/api/admin/*` request in the first place (spec §8's
no-403-noise rule holds by construction, not by a client-side check inside
the view). The nav button rendering it is gated the same way
(`(store.user?.is_admin ?? false) && …`).

**Load.** On mount, `getAdminUsers()` and `getAdminTiers()` fire once each,
both guarded by `sessionGeneration()` exactly like every other view's load
effect (a session change mid-flight drops the response). Both `users` and
`tiers` start `null` — not an empty array — and both gate the create form's
submit button: `tiers` so the tier select never briefly offers a hardcoded
guess before the config-defined catalog lands (`docs/backend-architecture.md`'s
tier config), and `users` so a create can never race the initial list
fetch — appending to a list that hasn't settled yet could drop the new row
under a stale `setUsers(list)` or duplicate it. Either fetch's failure
surfaces `m.adminLoadFailed` via `useCrudError`'s `fail` (the same
`hooks/useCrudError.ts` used by `RulesView`/`ProfilesView`/`TerminologyView`,
[described above](#profiles-in-the-frontend)); a load failure leaves the
table empty rather than partially populated.

**Create** (`CreateForm`, M6 task 4): a small form with every input
controlled by React state (unlike `UserRow`'s draft-or-prop name input,
described below) that pre-validates the 12-char password floor client-side
(`ADMIN_MIN_PASSWORD_LENGTH`, `api/client.ts` — the backend's own floor is
not exposed by any endpoint, so this is a hardcoded mirror like
`MIN_PASSWORD_LENGTH` elsewhere) before ever calling `postAdminUser`, and
disables its own admin checkbox with `m.adminGrantDisabledHint` while
`allow_additional_admins` is off, mirroring the server's 403.

**Row editing** (`UserRow`, M6 task 5): each row is keyed on `user.id`, not
on any field that changes under editing — folding `display_name` into the
key would remount the row after a name save and silently erase a password
already typed into that row's reset field. The display-name input instead
uses a draft-or-prop pattern: `useState<string | null>(null)` where `null`
means "not editing," so the input shows `draftName ?? user.display_name ??
''` and resyncs to a server-driven update without a remount. Blur commits
the trimmed draft — an unchanged value sends nothing, an emptied field
sends `{ display_name: null }` (explicit clear, not omission) — and returns
to showing the server value regardless of outcome.

Tier, admin, and active are single-field `PATCH`es fired directly from
each control's `onChange`, through one `save(user, patch)` helper next to
the load effect: it runs the `PATCH` through `useCrudError`'s `run` (so a
rejected mutation surfaces `m.adminChangeFailed` the same way create
failures do) and, on a same-session success, replaces that row's user in
`users` with the server's response — the write-back, not an optimistic
local patch, is what the row renders next. `save` returns whether the
change actually committed, since `run` swallows a rejection into the error
banner; password reset is the one caller that needs that signal to decide
whether to clear its field.

The tier `<select>` mirrors `tiers.includes(user.tier) ? tiers : [user.tier,
...tiers]` — a user can sit on a tier no longer in the config, and a
controlled select given a value outside its option list silently shows the
wrong thing, so the row keeps that value selectable even once retired.

Admin and active checkboxes mirror the two server lockout/permission guards
the UI cannot replace, exactly as the create form's checkbox mirrors the
promotion one:

- **Self-demotion/self-deactivation** (`isSelf`, `user.id === me?.id`)
  disables both checkboxes on the caller's own row outright — the backend
  409s a change that would leave zero active admins, and there is nothing
  a retry does differently, so the control simply isn't offered.
- **Promotion while `allow_additional_admins` is off**
  (`!user.is_admin && !allowMoreAdmins`) disables *promoting* a non-admin,
  with the same `m.adminGrantDisabledHint` title as the create form's
  checkbox. Demoting an existing admin stays enabled regardless of this
  flag — it only ever reduces privilege, which the flag never restricts.

**Password reset.** A per-row password input plus button, gated by the
same 12-char pre-check as creation (`fail(m.passwordTooShort(...))`
without calling the API for a too-short value) and a `resetPending` guard
disabling the button for the duration of an in-flight `PATCH` — without it,
a second click before the first response lands would revoke sessions and
write an audit row twice. The typed password clears only when `save`
reports the change committed; a failed `PATCH` leaves it in the field
under the error banner rather than silently discarding what the admin
typed.

**Own-row reset is text, not a control (B3).** The backend still lets an
admin's own `PATCH` carry a `password` field — self-demotion and
self-deactivation are the only self-edits the server 409s — but resetting
your own password through this table also bumps your own `token_epoch`,
revoking your own current session token immediately, with no re-login step
the way `AccountMenu.tsx`'s change-password dialog has. That was the M6
abrupt-self-logout gap; B3 resolves it on the client side by rendering the
own-row (`isSelf`) reset cell as a plain `adminSelfResetHint` string
("Use the account menu to change your own password.") instead of the
password input and button, rather than disabling those controls — visible
text that tells the admin what to do instead reads better for a
screen-reader user than a disabled control with no explanation. The
revocation semantics themselves are unchanged; only the self-service path
to trigger them moved to the dialog described above, which already handles
the resulting re-authentication.

## Internationalization

The UI ships seven locales (`i18n/{en,de,fr,es,it,ja,zh}.ts`) — independent of the
seven *checked* languages, though the sets coincide. The effective locale is the
user's explicit choice or the browser preference (`detectLocale`, primary-subtag
match). Components call `useMessages()`; non-React code calls `currentMessages()`.
Catalog entries are plain strings or functions (for counts/parameters);
`interpolate()` splices React nodes into translated templates. A vitest test asserts
key equality across all catalogs, so a missing translation fails CI.

### UI copy register (B2)

de/fr/es/it address the user informally (*Du*, *tu*, *tú*) in sentences
that instruct or speak to them: click-hints, retry prompts, session
notices, second-person possessives. Button/menu labels and
control-description tooltips keep their conventional forms (de/fr/es
infinitives, it imperatives), and neutral statements of fact stay
impersonal — deliberately including the `adminSelfResetHint` family. en
carries no register, ja stays polite です/ます, zh has no second person:
all three are untouched by register work. `i18n/register.test.ts` pins
both directions — formal markers must not reappear (de Sie/Ihnen/Ihr…/
klicken; fr veuillez/vous/votre/vos and -ez imperatives; es
vuelva/inicie/usted; it riprovare/Lei) and the converted informal
strings must stay present.

## API client

`api/client.ts` is the only module that talks to the network: small typed wrappers
around `fetch` for every endpoint, each carrying the caller's bearer token via
`authHeader()`, and `subscribeCheck()` — a hand-rolled `fetch()`-based SSE reader for
the check stream, not `EventSource` (see [Authentication](#authentication) for why).
`subscribeCheck()` returns an unsubscribe function that aborts the underlying request;
the `done` event, a non-OK response, and a stream error all close it and settle
exactly once. The request/response types are defined in `types.ts` and match
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
  Since M2 requires a caller, the script needs `FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD` in
  its environment: it logs in once via `POST /api/auth/login` for its own API staging
  calls, and drives the same login form in the browser before taking any shot.
