# Multi-User Capability — Milestone Roadmap

Spec: `docs/superpowers/specs/2026-07-24-multi-user-auth-design.md` (merged
in PR #14). This roadmap defines the milestone boundaries; **each milestone
gets its own branch, its own detailed plan, and its own PR**, written just
before that milestone starts rather than all up front — earlier milestones
reveal facts later ones should use.

## The rule that orders the milestones

**After every merge, `main` must be a working application.** That single
constraint decides the sequence below: authentication is built before it is
enforced, and enforcement lands together with the frontend that can satisfy
it. No milestone leaves main in a state where the UI cannot talk to the API.

## Milestones

| # | Branch | Delivers | Leaves main working because |
|---|---|---|---|
| M1 | `multi-user-auth-core` | `users` + `admin_audit` tables, `UserStore`, password hashing, `TokenVerifier` + `LocalTokenVerifier`, `/api/auth/*`, `/api/admin/users*`, admin bootstrap, operator CLI. Dependencies exist but are **not applied** to existing routers. | Purely additive. Existing endpoints are untouched and unauthenticated, so the current frontend keeps working. |
| M2 | `multi-user-enforcement` (planning branch for PR #22; implemented on `multi-user-m2-implementation`) | Auth applied to every `/api/*` router; CORS tightened; frontend auth slice, login gate, account menu, Bearer on every request, `fetch`-based SSE reader replacing `EventSource`. | Backend enforcement and the frontend that satisfies it ship in the same PR — the one place they cannot be split. |
| M3 | `multi-user-ownership` | `owner_id` scoping for documents/folders; nullable `owner_id` + global built-ins for profiles/domains; **caller scoping for the in-memory check-jobs registry** (see the note below); the guarded table rebuilds; seeders write global rows; `is_global` in responses; 404-not-403 semantics. | Single-user data migrates to admin ownership; one logged-in user sees exactly what they saw before. |
| M4 | `multi-user-tiers` | `tiers:` config, `resolve_llm_selection` with graceful degradation, feature gates, `effective_llm` reporting, `allowed` flags on `/api/routing` + `/api/providers`, `/api/auth/me` policy payload, frontend gating and degradation notes. | Default config grants the admin everything; behavior is unchanged until tiers are configured. |
| M5 | `multi-user-metering` | `llm_usage` ledger, `reserve_llm_run` (quota + admin ceiling + concurrency in one transaction), startup/staleness sweep, size caps, 429 + backpressure, skip reasons on scorecard/SSE, frontend quota and skip notices. | Limits default high enough to be inert for existing usage; every denial degrades rather than erroring, except the documented 429. |
| M6 | `multi-user-admin-ui` | Admin view as a fifth `activeView`, gated on `is_admin`; user table with create/edit/deactivate/reset. | Frontend-only addition over the M1 admin API. |

## M3 must also scope check jobs — decided 2026-07-26

`app/services/jobs.py` has no owner concept, and both id-addressable check
endpoints look a job up by id alone with no caller check:
`GET /api/checks/{check_id}` (`app/api/checks.py:132-136`) and
`GET /api/checks/{check_id}/events` (`:146-150`). Both return findings, which
carry **quoted spans of the document text**, plus the scorecard.

In M2 that is consistent rather than broken — nothing is owner-scoped, so
shared checks match shared documents. It becomes a privacy gap precisely when
M3 makes documents private: the UI would look isolated while any authenticated
account could read another's check results by id. Partial isolation is worse
than either extreme, because nothing signals that it is partial. Check ids are
UUIDs, which is obscurity, not authorization.

Owner's decision (2026-07-26): anything that can reveal something about a
user's document is in scope for M3 — this must not ship as a residual.

**Scope note, verified rather than assumed:** suggestions and rewrites do
*not* need the same treatment. `POST /api/suggestions`
(`app/api/suggestions.py:49`) receives the text in the request body and slices
`body.text[start:end]`; it stores nothing and exposes no id, so there is no
artifact to read across accounts. Its frontend-side staleness window was real
and was closed in M2 with generation guards in `checking/suggest.ts`.

**Also re-evaluate the dated safety comments.** Several M2 guards are
justified in-code by reasoning of the shape "this data is not scoped to a
user, so a stale write is indistinguishable from a fresh one". That reasoning
expires in this milestone. The two writes that matter put terminology domains
into the shared store after an unguarded await — grep `getDomains(` in
`frontend/src`, which finds exactly them: `frontend/src/App.tsx:96` (whose
effect carries the comment "No generation guard needed", `App.tsx:89`) and
`frontend/src/terminology/TerminologyView.tsx:37` (which carries no comment at
all). Both become genuine leaks of another user's domain names the moment
domains carry an `owner_id`. Profile writes are already guarded. Audit by
symbol — grep `getDomains(` and `No generation guard` — and re-check every
hit rather than trusting the comments.

## Cross-milestone interfaces

Names fixed here so a milestone's implementer can rely on them without
reading other milestones' plans:

- `app/core/auth.py`: `hash_password(str) -> str`,
  `check_password(str, str | None) -> bool`,
  `issue_token(user_id: int, secret: str, *, epoch: int) -> str`,
  `TokenVerifier` protocol with `verify(token: str) -> VerifiedToken`
  (`VerifiedToken` is a frozen dataclass of `user_id: int` — **always the
  local `users.id`, in every auth mode** — and `issued_at: datetime`, tz-aware
  UTC; M2 changed this from a bare `int` return so `get_current_user` could
  compare `issued_at` against `users.password_changed_at` for revocation
  without the verifier knowing anything about that column), `LocalTokenVerifier(secret)`.
  M3 added a third field, **`epoch: int | None`**: local tokens always carry
  an integer epoch, equality-checked (not ordered) against the issuing
  user's `users.token_epoch`, giving password-change revocation that is
  exact regardless of same-second timing — the residual M2's
  `password_changed_at` comparison left open. `None` is reserved for a
  verifier with no epoch concept at all (the future Supabase verifier),
  in which case `get_current_user` falls back to the `password_changed_at`
  comparison M2 already had. `issue_token` gained the matching keyword-only
  `epoch` parameter; every caller (today, just `POST /api/auth/login`)
  passes the user's current `token_epoch`.
- `app/api/deps.py`: `get_current_user(request) -> CurrentUser`,
  `require_admin(...) -> CurrentUser`; `CurrentUser` carries
  `id, email, display_name, tier, is_admin`.
- `app/services/users.py`: `UserStore(db_path)`, `User` model (**never
  carries `password_hash`**).
- M4 adds `app/core/permissions.py`:
  `resolve_llm_selection(policy, requested, language, *, settings) ->
  EffectiveSelection` — `settings` is keyword-only (routing-table and
  default-provider lookups need it, but every call site already has a
  `policy` and a `requested` positionally, so keeping `settings` keyword-only
  keeps those call sites self-documenting). M4 also adds
  `app/api/llm_gate.py`'s `get_effective_provider` — the single gate every
  LLM-invoking endpoint resolves through (no route touches
  `app.state.provider_factory` directly). **As built (M5)**, its signature
  is `get_effective_provider(app, user, requested, language, *, text_chars,
  source, run_id) -> (EffectiveSelection, LLMProvider | None, LlmReservation
  | None)` — a 3-tuple, not the M4 pair — and it runs the full order **422
  → size cap → resolve_llm_selection → provider construction → reservation**
  (`docs/backend-architecture.md#llm-usage-metering`).
- **As built (M5)**, `app/services/usage.py`'s `UsageStore.reserve_llm_run`
  signature is `reserve_llm_run(user: MeteredUser, limits, server_limits,
  requested, effective, text_chars, source, run_id, *, now=None) ->
  QuotaDecision` — `user` is typed against the `MeteredUser` protocol
  (`id`, `is_admin`), not a concrete class, so the service needs no import
  from `app.api`; `now` is keyword-only and exists only for deterministic
  tests (defaults to the real current UTC time).
- **As built (M5)**, `limits_for(*, tier, is_admin, settings) ->
  TierLimitsSettings` (`app/core/permissions.py`, alongside `policy_for`/
  `features_for`) resolves the caller's per-user quota/concurrency numbers:
  the admin ceiling for an admin or an inert (no-`tiers:`) deployment, the
  tier's own required block when configured, the admin ceiling again as the
  fallback for an unknown tier name (a case that only ever reaches `/me`'s
  display and the gate's size-cap pre-check, since an unknown tier's policy
  floors the LLM phase out before any reservation is attempted).
- **Documented deviation from spec §6.4/§6.5** (Design decision 7, M5): the
  spec describes the inline limit/reset numbers traveling on the
  `effective_llm` report itself. As built, `EffectiveLlmReport`/
  `SuggestionResponse.skipped` carries the skip **code** only
  (`"quota_exhausted"`/`"document_too_large"`/`"llm_unavailable"`) — the
  numbers (`usage.limit`, `limits.max_llm_document_chars`, etc.) travel
  separately, on `/me`. The frontend's `skipNoticeText`
  (`frontend/src/checking/skipNotice.ts`) is what recombines a code from a
  check/suggestion response with the numbers from the current `/me`-derived
  user object into display text.
- `/api/auth/me` grows across milestones: M1 returns user identity and
  `is_admin`; **M4 delivers the LLM policy and feature flags** (`policy:
  PolicyPayload`, `app/api/auth.py`); **M5 adds `usage: UsagePayload`
  (`used_today`, `limit`) and `limits: LimitsPayload`
  (`max_document_chars`, `max_llm_document_chars`,
  `concurrent_llm_runs`)** — see the deviation above for why these numbers
  live here rather than on the per-run report. Each milestone extends the
  same response model rather than adding a second endpoint.

## Conventions for every milestone

- Branch from the current `main`, open a PR at the end, request a Copilot
  review, and **resolve every review thread** — the `main` ruleset blocks
  merging while any thread is unresolved.
- `main` is PR-only: LOGBOOK and architecture-doc updates travel inside the
  milestone's PR, not as direct pushes.
- Gates before opening a PR: backend `uv run pytest -q` (zero warnings) from
  `backend/`; frontend `npx vitest run && npm run lint && npm run build`
  from `frontend/` — **corrected (M5)**: no separate `npx tsc --noEmit`
  step. `frontend/tsconfig.json` is a root file with `"files": []` that only
  wires up `references` (`tsconfig.app.json`/`tsconfig.node.json`); a bare
  `tsc --noEmit` against it type-checks **zero files** in this workspace
  layout and always exits clean regardless of real errors. `npm run build`
  (`tsc -b && vite build`) is what actually runs the project-referenced
  build-mode typecheck — it was always the real gate; the separate step was
  a no-op that looked like coverage it didn't provide.
- The live database `backend/data/fabulous.db` is never read or written by
  tests, and any migration is rehearsed on a **copy** of it before the PR.
- API keys come from the environment only; nothing is ever written to the
  repository or the database.

## Backlog — deferred, not attached to a milestone

Decisions made deliberately during milestone work, recorded so they are not
rediscovered as bugs. None of these blocks a milestone.

| # | Item | Deferred because | Earliest sensible point |
|---|---|---|---|
| B1 | **Per-user UI preference survival.** M2 purges the persisted settings blob on a user change. Switch it to a per-user namespace instead — `useStore.persist.setOptions({ name: 'fabulous-writing-settings:' + user.id })` then `rehydrate()`. **Note the trap:** switching the name and rehydrating is not sufficient. When the incoming user has no blob under the new key, zustand merges nothing and the *previous* user's in-memory preferences survive — and are then written into the new user's namespace on the next change. The implementation must reset the persisted slice to its declared defaults before awaiting rehydration, without deleting either namespace. | Purging is the simpler correct behaviour and creates no migration debt: going purge → namespaced later strands nothing, whereas the reverse would leave orphaned per-user blobs. | After M3, when data is actually per-user. `documents.ts` already falls back to the first document when a persisted `currentDocId` is not in the list, so the stale-id case is covered. |
| B2 | **Informal UI register.** Move the seven locale catalogs from the current impersonal register to a friendlier one (*Du*, *tú*, *tu*). | A half-converted catalog reads worse than either register applied consistently. | A single deliberate pass over all seven files (~165 keys each). Substantial for de/fr/es/it; largely inert for ja/zh. |
| B3 | **A proper dialog pattern.** M2 puts the change-password form inline in the account popover. | A scrim already exists — `FolderDefaultsDialog` renders `.dialog-overlay` (`App.css:1719`) with backdrop-click dismissal — but focus trap, Escape handling and scroll lock do not. Three short fields did not justify building those, and a half-accessible dialog is worse than a popover. | A UI polish phase: harden `.dialog-overlay` into a reusable accessible dialog, then move the password form onto it. |
| B4 | **Landing-page treatment for the login gate.** M2 ships a centred card. A split layout with the wordmark beside the form was the alternative. | A sign-in screen is a door; M2's job is enforcement, not personality. | The same UI polish phase — and especially if the product ever gets a public landing page, since the two should look related. |
| B5 | **Failure classification on the `llm_usage` ledger.** Decided with the owner 2026-07-27 (PR #30 review discussion): `status='failed'` conflates every error shape from provider-unreachable to unparseable output. Add two nullable columns written only by `finish_run` on the failed path: `fail_stage` (`'request'` — unreachable/auth/timeout before or while sending; `'provider'` — the provider's API errored while processing; `'response'` — broken or unparseable output on reception) and `fail_detail` (error *metadata* only: exception class, HTTP status, first N sanitized chars — **never raw provider responses**, which can quote document text; the ledger deliberately stores `text_chars`, not text). The stage enum carries most of the analytical value at zero risk; the detail string needs that guardrail. | M5 shipped the uniform `failed` semantics first (parse failures included, PR #30 round 5); classification is additive. But §5.3's own argument cuts against waiting long: a column added late leaves rows that can never be backfilled — every week without it is failure history that can never be classified. | A small dedicated follow-up shortly after M5 merges, while the table is days old — it need not wait for M6. |
| B6 | **Credit-based LLM budgeting.** Decided with the owner 2026-07-27 (PR #30 review discussion): the M5 run counter is too coarse — a 100k-char quality-tier check, a one-word suggestion, and an auto-title all cost 1 against one limit regardless of model. Replace with credits per window (hour/day/month): per-run cost = f(request size, response size, model/tier cost factor, `source` weighting — naming ≈ free), enforced in the same `reserve_llm_run` transaction as `SUM(credits in window) <= budget`, admit-on-estimate (chars x factor) / settle-on-actual at `finish_run`. Binding constraint carried over from spec §6.4: credit limits are enforced *between* runs, never as mid-run cutoffs — overshoot is bounded by one run. The ledger already records the cost inputs (`text_chars`, `source`, `provider`/`model`/`llm_tier`, token columns), so historical rows can be re-costed retroactively when tuning the formula. Config: `credits_per_<window>` in the tier limits blocks plus a model cost-factor map, house-style load-time validation; `/me` and the quota indicator generalize (used/limit becomes credits-used/budget). **Owner note: on backlog pickup, expect this row to expand into a full spec section of its own.** | Fair settlement needs real token counts — [B7] is the prerequisite; char-based estimation misprices by language (CJK). M5's simple counter ships first per "record richly, limit simply". | After [B7] lands. Windows beyond the UTC day need one extra index (`user_id`, `created_at`); hour/month derive from `created_at`/`day`. |
| B7 | **Provider usage reporting (prerequisite for B6, bundled with B5).** The `LLMProvider.generate` protocol returns only text; every provider API actually reports exact input/output token counts in its responses, and we throw them away — the checks path scrapes an approximate output count from the streaming progress callback, suggestions/naming record NULL. Extend the protocol so `generate` returns usage metadata (all five implementations: ollama, claude, openai-compat x2, bedrock; plus FakeProvider), and settle real `input_tokens`/`output_tokens` into the ledger's existing columns at `finish_run`. | Same never-backfillable argument as [B5]: token history not captured now is lost — every week without it is spend data that can never be recovered. The protocol change touches all providers at once, so it deserves its own focused pass rather than riding along inside B6. | The same "shortly after M5 merges" window as [B5] — the two make one natural follow-up; [B6] builds on both. |
| B8 | **Backend test-suite execution time.** Dev-technical (owner request 2026-07-27): 1079 tests take ~244 s, and agent-driven workflows run the suite many times per task — the cost compounds into every fix-round gate. Owner's measured `--durations=25` shows a **flat distribution** (top 25 slowest = only ~16 %, no outlier tail): the signature of constant per-test fixed costs (~190 ms average), so the lever is the fixture chain's base price, not individual slow tests. Measure the split first (`pytest --durations=0` aggregated by setup/call/teardown; a 50-trivial-tests baseline file requesting the standard fixtures prices the chain; `--collect-only -q` isolates import cost). Suspects in expected-impact order: (1) **bcrypt in tests** — every user-creating fixture pays production hashing (100–300 ms x 1079 ≈ potentially half the suite); minimize rounds/inject a cheap hasher in conftest, with one guard test pinning the production cost. (2) **Per-test schema/app cost** — `create_app()` per test re-runs migrations/seeders/engine setup; schema once per scope + per-test transaction rollback where isolation provably permits; session-scoped app/models with per-test dependency overrides only (mind the create_app history: bare `create_app()` must never touch the live DB, and widened fixtures must not reintroduce cross-test state). (3) **Real sleeps in the M5 metering tests** (`test_backpressure_pause_does_not_block_the_event_loop`, `test_cancellation_during_backpressure_sleep`, `test_pause_happens_outside_the_reservation_transaction`): the pause is already a config value (`concurrency_reject_delay`) — set it near 0 wherever the assertion is about behavior, not wall-time; freezegun/time-machine cannot help because `asyncio.sleep` rides the event-loop clock. (4) **`pytest-xdist -n auto --dist loadfile`** — near-linear here precisely because costs are uniform; our SQLite-per-`tmp_path` layout gives per-worker DB isolation structurally (no Postgres template-DB machinery needed); audit for hidden shared state rather than assuming. Expected ~40–60 s on 8 cores from xdist alone; **combined target &lt;30 s**. Also: collection hygiene (`testpaths`/`norecursedirs`), coverage off locally / `COVERAGE_CORE=sysmon` on 3.12+, `-p no:cacheprovider`, and `--lf`/`pytest-testmon` for the agent inner loop (full suite stays the pre-push/CI gate). | Not user-facing, so it never outranked a milestone; but the 4-minute wall multiplies into every fix round's gate. | Any gap between milestones; independently of M6. Re-measure after each lever — stop when comfortably under 30-60 s rather than chasing the long tail. |
| B9 | **Save-failure surfacing in the editor.** From PR #30 round 8: a below-char-cap document whose findings/scorecard payload exceeds the byte budget gets an uncoded 413 that autosave correctly treats as non-retryable — but the char counter shows nothing (text is under the cap), there is no save-error state, and a document switch can overwrite the single-slot recovery buffer, so edits can be lost with no indication. Wants a persistent save-error surface (and possibly a navigation confirm while a save is failing) rather than more retry logic. | Needs >5 MB of findings to trigger — an extreme edge — and a save-error surface is a UX feature beyond a review patch; the transient-error architecture (autosave.ts) is otherwise sound. | The B3 dialog/UI-polish phase — a save-status indicator belongs to the same pass; revisit the navigation guard there. |
