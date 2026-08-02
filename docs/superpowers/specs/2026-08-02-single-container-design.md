# Single-Container Setup (B17, #58) — Design

**Item:** [#58](https://github.com/saigyo/fabulous-writing/issues/58).
One Docker image on GHCR, a re-runnable setup wizard, and minimal-config
docs — the "pull, wizard, run" experience. The image definition is the
same one B16 (#57, fly.io) later builds on.

**Scope decisions (settled with Markus, 2026-08-02):**

- **Licenses:** `THIRD-PARTY-NOTICES.md` with full license texts,
  committed to the repo, baked into the image, CI drift check. An
  in-app licenses/about page is a separate backlog issue, not B17.
- **Wizard:** containerized Python CLI as the implementation, plus a
  thin `fabulous.sh` wrapper for one-liner invocation. Re-runnable —
  provider switching after first use is a first-class path.
- **Releases:** deliberate, versioned (semver, starting `v0.1.0`) —
  never automatic on push to main. Tag push triggers the release
  workflow; proper GitHub Release with generated notes.
- **Layers/caching:** Dockerfile layer order by change frequency;
  registry-backed BuildKit layer cache on GHCR (the ~1.5 GB of
  model/dictionary layers outgrow the 10 GB GHA cache).

## Current state (audit, 2026-08-02)

- No Dockerfile, compose file, or container tooling anywhere in the
  repo. No release workflow; CI is per-area test workflows
  (`backend.yml`, `frontend.yml`) plus CodeQL.
- The backend does **not** serve the frontend: dev runs two origins
  (Vite 5173 → API 8000) with CORS. No `StaticFiles` mount exists.
- `load_settings()` (`backend/app/core/config.py`) reads exactly
  `backend/config.yaml` (or built-in defaults); there is no env
  override for the config path. Secrets are env-only by design:
  `FW_AUTH_SECRET`, `FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD`, provider
  keys (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`MISTRAL_API_KEY`, and
  `<NAME>_API_KEY` for extra providers).
- `db_path` is a top-level setting, default `backend/data/fabulous.db`.
  Ollama is configured via `providers.ollama_base_url`/
  `providers.ollama_model` and selected via
  `providers.default_provider` — all config.yaml, not env.
- Language assets are installed by scripts today:
  `backend/scripts/install-dictionaries.sh` (Hunspell, en de fr es it)
  and `install-models.sh` (six spaCy `sm` models + ginza/ja, pinned as
  wheel URLs in `[tool.uv.sources]`; the models sit in the `dev`
  dependency group).
- Dependency surface for license collection: ~130 packages in the
  backend venv (runtime subset is what ships), 193 lockfile entries in
  the frontend (only the ~10 production deps + their transitives reach
  `dist/`), plus spaCy models and Hunspell dictionaries.
- Repo license: MIT.

## Versioning and releases

- **The git tag is the single source of truth for the app version.**
  Main's ruleset declines direct pushes, so a release workflow can
  never commit version bumps back; `pyproject.toml`/`package.json`
  versions stay untouched and meaningless. Semver, starting `v0.1.0`,
  pre-1.0 semantics (minor = features, patch = fixes).
- Cutting a release = pushing an annotated tag `vX.Y.Z` (owner does
  this, or asks for it). The tag triggers `.github/workflows/release.yml`:
  1. Build the multi-arch image (linux/amd64 + linux/arm64).
  2. Push to `ghcr.io/saigyo/fabulous-writing` tagged `X.Y.Z` and
     `latest`.
  3. Only after a successful push, create the GitHub Release for the
     tag with `generate_release_notes: true` — a Release page never
     exists without its image.
- The version reaches the image as a build arg → OCI label
  (`org.opencontainers.image.version` and friends) and env var
  `FW_APP_VERSION`; `/api/health` includes it (`version` field,
  `"dev"` when unset) so a running container is identifiable.

## The image

One multi-stage `Dockerfile` at repo root; `.dockerignore` excludes
`node_modules`, venvs, `backend/data/`, caches, and local config.

- **Stage `frontend-build`** (`node:26-slim` — the current Node line,
  matching the owner's local 26.x; build-time only, no runtime
  exposure): `npm ci`, `npm run build` → `/app/dist`.
- **Stage `runtime`** (`python:3.13-slim`), layers strictly ordered by
  change frequency so the registry cache pays off:
  1. OS packages: `hunspell` dictionaries' prerequisites and `curl`
     (healthcheck) — changes ~never.
  2. Hunspell dictionaries (en de fr es it, via the existing script).
  3. Python runtime dependencies: copy `pyproject.toml` + `uv.lock`
     only, `uv sync --locked --no-dev` — busts only on lockfile
     changes, never on code edits.
  4. spaCy/ginza models (the pinned wheel URLs; biggest and most
     stable layer).
  5. Application: backend source, `rules/`, `demos/`,
     the built `dist/` from stage 1, `THIRD-PARTY-NOTICES.md`, and
     `config.container.yaml` — the production base template the wizard
     extends (the repo's `config.yaml`/`config.example.yaml` are dev
     artifacts and stay out of the image).
- Non-root user; `VOLUME /data` (SQLite) and `/config` (wizard
  output); port 8000 inside the container (host port is the user's
  choice via `-p`); `HEALTHCHECK` against `/api/health`.
- **Entrypoint dispatch:** default command serves the app
  (`uvicorn`, single process — plenty for the single-admin target);
  `setup` runs the wizard. `FW_CONFIG_FILE=/config/config.yaml` is set
  in the image environment. Before serving, the entrypoint sources
  `/config/fabulous.env` if present — secrets stay inside the config
  volume and never need a host-side `--env-file` (which cannot read
  from a named volume); real environment variables still override,
  which is exactly the hook B16/fly.io secrets will use.

## Single-origin serving (code changes)

Two small, dev-neutral backend changes:

- **`FW_CONFIG_FILE` env var:** `load_settings()` honors it as the
  config path when set (explicit `config_file` argument still wins;
  tests unaffected — they pass `Settings` directly).
- **`frontend.dist_dir` setting** (new, optional, default unset): when
  set, the app mounts the directory's assets and serves an SPA
  fallback (`index.html`) for non-`/api` paths. Unset — dev and every
  existing test — nothing changes. With single-origin serving, CORS
  is unnecessary in the container (same origin); the CORS middleware
  simply never matches.

## The wizard

`python -m app.setup_wizard` inside the image, invoked as
`docker run --rm -it -v fabulous-config:/config ghcr.io/… setup`.

**Contract: the wizard owns `/config` and regenerates both files
completely on every run** — `fabulous.env` (secrets only) and
`config.yaml` (non-secret config, extending the baked-in production
template with `db_path: /data/fabulous.db`, the chosen
`providers.default_provider`, and Ollama settings when applicable).

- **First run:** prompts for admin email + password (min-length
  enforced), generates `FW_AUTH_SECRET` (≥32 chars,
  `secrets.token_urlsafe`), provider choice — exactly one of
  Anthropic/OpenAI/Mistral (key format-validated) **or** Ollama
  (base URL defaulting to `http://host.docker.internal:11434`, with
  the Linux gateway hint; reachability + model presence verified from
  inside the container — the same network position the app runs in).
- **Re-run:** existing files are parsed and every prompt pre-filled
  ("keep current" is the default). Because the files are rewritten
  whole from the merged answers, switching providers can never leave
  a stale key or Ollama URL behind — the exactly-one-provider
  invariant holds on every write. `FW_AUTH_SECRET` is kept by default
  (rotating it is an explicit choice, with a "this logs you out"
  warning). Admin credentials are shown pre-filled with honest
  messaging: they bootstrap only on first start against an empty
  database; afterwards the password is changed in the app.
- Previous files are backed up (`*.bak`) before overwrite. Secrets are
  never echoed back, logged, or written anywhere but `/config`.
- Ollama connectivity failure is a warning with troubleshooting hints,
  not a hard abort — the user may be setting up before starting
  Ollama.

**`fabulous.sh`** (repo root, POSIX sh): thin wrapper offering
`setup` and `serve` subcommands that compose the `docker run`
invocations (volumes `fabulous-config:/config` +
`fabulous-data:/data`, port mapping, `latest` by default with an
optional version argument). No logic beyond argument plumbing — the
wizard and entrypoint own all behavior.

## Third-party licenses

`scripts/collect-licenses.py` (repo root `scripts/`, new) generates
`THIRD-PARTY-NOTICES.md`:

- **Python:** `pip-licenses` against a runtime-only environment
  (`uv sync --locked --no-dev`) — dev/test tooling is not distributed
  and must not appear.
- **Frontend:** `license-checker` over `--production` npm deps — the
  set that actually reaches `dist/`.
- **Hand-curated entries** (data file consumed by the script) for what
  no package manager tracks: the six spaCy models and ginza (model
  licenses differ from spaCy's MIT) and the five Hunspell dictionaries
  (classically GPL/LGPL/MPL multi-licensed — entries name the license
  actually relied on).
- Output per package: name, version, SPDX identifier, **full license
  text** (attribution clauses require the text, not the name).
  Committed at repo root, copied into the image, linked from the
  README.
- **CI drift check** (in the PR workflow set): regenerate and
  `git diff --exit-code` — a Dependabot bump that changes the
  dependency set fails until the notices file is regenerated.
- Debian base-image packages keep their `/usr/share/doc/*/copyright`
  files in the image — the standard attribution mechanism for distro
  content; the notices file states this.
- The in-app licenses page is **not** B17 — tracked as a new backlog
  issue.

## CI and caching

- **`release.yml`** (new, on tag `v*`): buildx multi-arch build,
  `cache-from`/`cache-to` `type=registry,ref=ghcr.io/…:buildcache,mode=max`,
  push image, then create the GitHub Release. Concurrency-guarded;
  GHCR auth via `GITHUB_TOKEN` (`packages: write`).
- **`docker.yml`** (new, PR/push paths-filtered to Dockerfile and its
  inputs): amd64 build-only against the same registry cache (read),
  no push — proves the image still builds without cutting anything.
  The license drift check runs here too (regenerate + diff).
- Existing backend/frontend workflows unchanged — except
  `frontend.yml` bumps `node-version` 24 → 26 so local builds, CI,
  and the image builder stage all use the same Node line.

## Docs

- README: a one-screen quickstart (pull → `setup` → `serve`, both via
  `fabulous.sh` and as raw `docker run`), the release/versioning
  convention, plus troubleshooting for the two classic tripwires:
  Ollama unreachable from the container (macOS/Windows
  `host.docker.internal` vs. Linux `--add-host`/gateway) and host
  port collisions. Backup = "copy the data volume/directory".
- `docs/backend-architecture.md`: config-loading change
  (`FW_CONFIG_FILE`), static serving, wizard module.
- `docs/frontend-architecture.md`: production serving model
  (single-origin, no CORS).

## Verification

- Backend: existing suite green, zero warnings; new tests for
  `FW_CONFIG_FILE` resolution, `frontend.dist_dir` mounting/SPA
  fallback (tmp dir with a stub `index.html`), wizard file generation
  and re-run merging (tmp `/config`; no network in tests — the Ollama
  probe is faked). All tests keep passing `tmp_path`-based `Settings`;
  the live DB and dev ports are never touched.
- Guard tests mutation-verified per standing rule (e.g., delete the
  SPA-fallback route → test fails; drop a dependency from the
  notices data → drift check fails).
- Local end-to-end (scratch stack rules: never ports 5173/8000):
  build the image, run the wizard against a scratch config volume,
  start the container on a scratch port, log in as the bootstrapped
  admin, run a check through the API, verify the SQLite file lands in
  the data volume and survives container replacement, confirm
  `THIRD-PARTY-NOTICES.md` and `/usr/share/doc` copyrights are
  present in the image.
- Release workflow verified by cutting `v0.1.0` as B17's finale:
  image pulls from GHCR on both architectures, Release page exists
  with notes, `/api/health` reports `0.1.0`.

## Out of scope

- fly.io deployment (`fly.toml`, volumes, secrets) — B16 (#57), which
  reuses this image.
- Supabase items (B14 #55, B15 #56).
- In-app licenses/about page (new backlog issue).
- Installing Ollama or pulling models; multi-user setup; any auth
  changes; docker-compose (single container needs none).

## Sequencing

B9 (#42) is deliberately deferred; B17 now, B16 next (reuses the
image). Usual shape: planning PR (this spec + plan, squash-merged),
then one implementation PR (`Closes #58.`), then the `v0.1.0` release
tag as the live verification.
