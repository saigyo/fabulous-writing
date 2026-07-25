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
| M2 | `multi-user-enforcement` | Auth applied to every `/api/*` router; CORS tightened; frontend auth slice, login gate, account menu, Bearer on every request, `fetch`-based SSE reader replacing `EventSource`. | Backend enforcement and the frontend that satisfies it ship in the same PR — the one place they cannot be split. |
| M3 | `multi-user-ownership` | `owner_id` scoping for documents/folders; nullable `owner_id` + global built-ins for profiles/domains; the guarded table rebuilds; seeders write global rows; `is_global` in responses; 404-not-403 semantics. | Single-user data migrates to admin ownership; one logged-in user sees exactly what they saw before. |
| M4 | `multi-user-tiers` | `tiers:` config, `resolve_llm_selection` with graceful degradation, feature gates, `effective_llm` reporting, `allowed` flags on `/api/routing` + `/api/providers`, `/api/auth/me` policy payload, frontend gating and degradation notes. | Default config grants the admin everything; behavior is unchanged until tiers are configured. |
| M5 | `multi-user-metering` | `llm_usage` ledger, `reserve_llm_run` (quota + admin ceiling + concurrency in one transaction), startup/staleness sweep, size caps, 429 + backpressure, skip reasons on scorecard/SSE, frontend quota and skip notices. | Limits default high enough to be inert for existing usage; every denial degrades rather than erroring, except the documented 429. |
| M6 | `multi-user-admin-ui` | Admin view as a fifth `activeView`, gated on `is_admin`; user table with create/edit/deactivate/reset. | Frontend-only addition over the M1 admin API. |

## Cross-milestone interfaces

Names fixed here so a milestone's implementer can rely on them without
reading other milestones' plans:

- `app/core/auth.py`: `hash_password(str) -> str`,
  `check_password(str, str | None) -> bool`,
  `issue_token(user_id: int, secret: str) -> str`,
  `TokenVerifier` protocol with `verify(token: str) -> int` (**returns the
  local `users.id` in every auth mode**), `LocalTokenVerifier(secret)`.
- `app/api/deps.py`: `get_current_user(request) -> CurrentUser`,
  `require_admin(...) -> CurrentUser`; `CurrentUser` carries
  `id, email, display_name, tier, is_admin`.
- `app/services/users.py`: `UserStore(db_path)`, `User` model (**never
  carries `password_hash`**).
- M4 adds `app/core/permissions.py`:
  `resolve_llm_selection(policy, requested, language) -> EffectiveSelection`.
- M5 adds `app/services/usage.py`:
  `reserve_llm_run(user, limits, server_limits, requested, effective,
  text_chars, source, run_id) -> QuotaDecision`.
- `/api/auth/me` grows across milestones: M1 returns user identity and
  `is_admin`; M4 adds the LLM policy and feature flags; M5 adds quota,
  size and concurrency limits. Each milestone extends the same response
  model rather than adding a second endpoint.

## Conventions for every milestone

- Branch from the current `main`, open a PR at the end, request a Copilot
  review, and **resolve every review thread** — the `main` ruleset blocks
  merging while any thread is unresolved.
- `main` is PR-only: LOGBOOK and architecture-doc updates travel inside the
  milestone's PR, not as direct pushes.
- Gates before opening a PR: backend `uv run pytest -q` (zero warnings) from
  `backend/`; frontend `npx vitest run && npx tsc --noEmit && npm run lint &&
  npm run build` from `frontend/`.
- The live database `backend/data/fabulous.db` is never read or written by
  tests, and any migration is rehearsed on a **copy** of it before the PR.
- API keys come from the environment only; nothing is ever written to the
  repository or the database.

## Backlog — deferred, not attached to a milestone

Decisions made deliberately during milestone work, recorded so they are not
rediscovered as bugs. None of these blocks a milestone.

| # | Item | Deferred because | Earliest sensible point |
|---|---|---|---|
| B1 | **Per-user UI preference survival.** M2 purges the persisted settings blob on login/logout. Switch it to a per-user namespace instead — `useStore.persist.setOptions({ name: 'fabulous-writing-settings:' + user.id })` followed by `rehydrate()`, replacing `purgePersistedSettings()`. | Purging is the simpler correct behaviour and creates no migration debt: going purge → namespaced later strands nothing, whereas the reverse would leave orphaned per-user blobs. | After M3, when data is actually per-user. `documents.ts` already falls back to the first document when a persisted `currentDocId` is not in the list, so the stale-id case is covered. |
| B2 | **Informal UI register.** Move the seven locale catalogs from the current impersonal register to a friendlier one (*Du*, *tú*, *tu*). | A half-converted catalog reads worse than either register applied consistently. | A single deliberate pass over all seven files (~165 keys each). Substantial for de/fr/es/it; largely inert for ja/zh. |
| B3 | **Modal pattern for the change-password form.** M2 puts the form inline in the account popover. A modal was the alternative. | The app has no modal or `<dialog>` anywhere, so it would mean building a scrim, focus trap, Escape handling and scroll lock from scratch — for three fields. | A UI polish phase, ideally when a second dialog genuinely needs the pattern, so it is built once and properly. |
| B4 | **Landing-page treatment for the login gate.** M2 ships a centred card. A split layout with the wordmark beside the form was the alternative. | A sign-in screen is a door; M2's job is enforcement, not personality. | The same UI polish phase — and especially if the product ever gets a public landing page, since the two should look related. |
