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
store field. Logic lives in plain TypeScript modules with colocated vitest tests;
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
├── profiles/
│   ├── profile.ts             # apply/dirty/rule-activation logic (mirrors backend XOR)
│   └── ProfilesView.tsx       # profile management view
├── header/
│   ├── ProfileSelector.tsx    # profile dropdown + dirty marker + save/reset
│   ├── LlmSelector.tsx        # tier dropdown + resolved caption + advanced pin panel
│   └── DomainMultiSelect.tsx  # checkbox-dropdown for terminology domains
├── sidebar/Sidebar.tsx        # counters, filters, finding list, detail card
├── rules/                     # rule catalog view + per-profile toggles
├── terminology/               # domain/term management view
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

The `persist` middleware saves only the settings slice (language, UI locale, domain
ids, provider, model, `tier`, llmAuto, `lastProfileByLanguage`) to localStorage;
results, caches, and `routing` are ephemeral. The document text is persisted
separately by the editor under its own key. A `migrate` step handles the pre-tier
persisted shape (version 0): those users had explicitly chosen a provider/model, so
they land in pinned mode (`tier: null`) rather than silently switching to tier mode.

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

Two guards keep results consistent:

- **Staleness**: before merging, the controller compares the current editor text with
  the checked snapshot; if the user typed in between, the results are discarded (the
  next debounced check is already scheduled anyway).
- **Supersede**: a module-level `currentCheckId` ignores SSE events from any check that
  is no longer the latest, and a new `runCheck` unsubscribes the previous stream.

`checking/suggest.ts` implements the two on-demand LLM actions (drop-in suggestions,
whole-sentence rewrites) against `POST /api/suggestions`, using the finding's *current*
tracked span. Results and errors are cached per finding in the store; only one LLM
action runs at a time. When vetting rejected every candidate, `vetMessage.ts` turns
that into an honest "no reliable suggestion" message instead of an empty list.

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
- `effectiveRuleConfig(profile)` — the `rule_config` payload for checks.
- `isRuleActive(profile, category, ruleId)` — mirrors the backend's XOR semantics
  (category toggle inverted by per-rule exceptions) so `RulesView` shows activation
  states without asking the server.

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
mirroring `LlmSelector`'s header control): picking a tier button saves `llm_tier` and
clears the pin; opening Advanced and picking a provider/model saves the pin and
implicitly leaves the tier button unselected (the profile is now pinned). A
`pinned-note` line with a clear (✕) button appears whenever the profile is pinned, so
returning to tier mode does not require the Advanced panel. `RulesView.tsx` shows the
per-profile banner, category checkboxes, and per-rule switches that write through to
`PUT /api/profiles/{id}`.

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
- **Screenshots**: `npm run screenshots` (`scripts/capture-screenshots.mjs`,
  playwright-core against the running dev servers) regenerates the README images.
