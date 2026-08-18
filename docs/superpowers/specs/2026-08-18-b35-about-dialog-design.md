# B35: About Dialog and Instance Identity — Design

**Issue:** #113 · **Branch:** `b35-about` · **Date:** 2026-08-18

## Problem

Two instances of the app can run side by side (e.g. the Docker container on
its SQLite volume and a dev backend in postgres mode) with pixel-identical
UIs; on 2026-08-17 edits silently landed in the wrong instance's database
because nothing on screen said WHICH instance the browser was pointed at.
The two distinguishing facts — release version vs dev, and the database
backend — must become visible: one at a glance, both on demand.

## Verified current state (code is truth)

- `/api/health` (unauthenticated, `app/main.py:271`) already returns
  `version` from `FW_APP_VERSION` with fallback `"dev"`. The release wiring
  is complete: `release.yml` extracts the tag → Docker build-arg
  `APP_VERSION` → `Dockerfile` `ENV FW_APP_VERSION`. Releases carry their
  tag; dev runs show `dev`. Nothing to build here.
- The frontend already fetches `/api/health` once per page load
  (`LoginGate` mount effect) and `HealthResponse` already types `version` —
  the value just isn't kept.
- `AccountMenu.tsx` (frontend/src/auth) and the `Dialog.tsx` primitive
  (frontend/src/ui) exist; the About surface composes them.
- The header is a fixed-50px flex row; the wordmark inside it is 1.15rem,
  leaving vertical room for a small second line beneath it.

## Requirements

### R1 — `db_backend` on `/auth/me` (the auth-gated channel)

`MeResponse` (`app/api/auth.py`) gains `db_backend: str` — the literal
`settings.database.backend` value (`"sqlite"` or `"postgres"`). This is the
fact that was invisible in the incident, exposed only to authenticated
users. `/api/health` stays byte-identical: version remains public, the
backend type does not. No new endpoint; the frontend's existing `/auth/me`
fetch delivers it at login with zero extra requests.

### R2 — Store plumbing

The frontend store keeps `version` (from the existing health fetch;
currently discarded) and `dbBackend` (from the me-response) alongside the
data those fetches already populate. Both are read-only session facts; no
re-fetching.

### R3 — About dialog

New "About" entry in `AccountMenu`, opening the existing `Dialog`
primitive. Content, in order:

1. The wordmark line (reuse the `Wordmark` component).
2. Version: localized label + the raw version string as delivered by
   `FW_APP_VERSION` (`1.2.3` — release.yml strips the tag's `v` prefix —
   or `dev`). Displayed verbatim, no re-prefixing.
3. Database: localized label + `SQLite` / `PostgreSQL` (display names
   mapped from the `db_backend` literal; an unknown id falls through
   verbatim rather than hiding the fact).
4. Copyright line: `© 2026 Markus Ackermann` (locale-neutral literal).
5. Source link: localized label + a link reading `GitHub` with hardcoded
   `href="https://github.com/saigyo/fabulous-writing"`,
   `target="_blank" rel="noopener noreferrer"`. Static literal URL only —
   the standing XSS rule (no dynamic `href` from user/LLM content) is not
   in play but the constant keeps it trivially auditable.

No system-info dump: exactly these five rows.

### R4 — Dev badge (at-a-glance disambiguation)

- In `Header()` (App.tsx), `<Wordmark />` is wrapped in a flex-column
  `brand` container; when `version === "dev"`, a second line renders
  beneath the wordmark: `dev · sqlite` / `dev · postgres` (before
  `dbBackend` is known — which cannot happen in practice, since the header
  renders only post-login — plain `dev`).
- Styling: ~0.65rem, muted color, tight line-height, left-aligned under
  the wordmark; the fixed 50px header height must not grow (existing
  header comment makes this a hard constraint).
- Release builds (`version !== "dev"`) render NO badge — the brand
  container then contains only the wordmark and the header is visually
  unchanged from today.
- The badge text is untranslated technical vocabulary; not a locale
  string.
- `Wordmark.tsx` itself stays untouched; `LoginGate`'s brand pane keeps
  the clean wordmark — the badge exists only in the app header, never on
  the login screen.

### R5 — i18n

New locale strings: About menu entry, dialog title, version label, database
label, source label. All 7 locales (en de fr es it ja zh), informal
register per the standing rules (Du/tu/tú), zh conventions, French
typographic apostrophes. `register.test.ts` / `i18n.test.ts` pick the new
keys up automatically. The strings `dev`, `SQLite`, `PostgreSQL`,
`GitHub`, and the copyright line are deliberately not localized.

### R6 — Tests (all guards mutation-verified per the standing rule)

Backend:
- `/auth/me` includes `db_backend: "sqlite"` in a default-settings app and
  `"postgres"` when `database.backend` is postgres (settings-level; no PG
  server — construct the response path, not a live pool; follows the
  existing MeResponse test style in test_auth_api.py).
- `/api/health` shape guard: response keys unchanged (no `db_backend`).

Frontend (vitest, existing patterns):
- AccountMenu renders the About entry; activating it opens the dialog.
- Dialog shows the version string, the mapped storage name, the copyright
  line, and the GitHub link with the exact literal href +
  `rel="noopener noreferrer"`.
- Badge: renders `dev · postgres` when version is `dev` and backend known;
  absent entirely when version is `1.2.3`.
- Register/i18n suites cover the new strings without new test code.

### R7 — Documentation

`docs/frontend-architecture.md`: About dialog + badge in the relevant
section. `docs/backend-architecture.md`: one line on `db_backend` in
MeResponse. No operator-doc changes (`FW_APP_VERSION` behavior is
unchanged and already documented).

## Out of scope

- Exposing the backend type unauthenticated.
- Any additional instance facts (ports, paths, auth mode, uptime).
- Login-screen badge.
- Changes to release/docker workflows (verified already correct).

## Delivery

One PR (`b35-about`, closes #113) through the usual pipeline: plan with
review, per-task reviews, final review, Copilot rounds, LOGBOOK entry as
last commit on cue, owner rebase-merge. Gates: backend pytest green zero
warnings (both modes), frontend vitest + lint green.
