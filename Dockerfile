# syntax=docker/dockerfile:1
# Layers are ordered strictly by change frequency (registry build cache):
# OS packages -> dictionaries -> Python deps (lockfile only) -> spaCy
# models -> application code. Editing app code must bust only the last
# layer.

FROM node:26-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Empty VITE_API_URL = relative API paths = single-origin serving
# (frontend/src/api/client.ts uses `??`, which keeps an empty string).
ENV VITE_API_URL=""
RUN npm run build

# Pinned to a FULL version deliberately: a floating tag (:latest, or even
# a minor line like :0.9) resolves to a new digest on releases, and a
# changed source invalidates every layer below it that mounts it —
# including the ~1.5 GB model layer. (Implementer: check the current uv
# release at https://github.com/astral-sh/uv/releases and pin that exact
# x.y.z.) Kept as its own stage — never COPYed into the runtime image — so
# the uv binary ships only as a build-time bind-mount and never ends up in
# a runtime layer, keeping the license inventory scoped to what actually
# runs.
FROM ghcr.io/astral-sh/uv:0.12.1 AS uv

FROM python:3.13-slim AS runtime
WORKDIR /app

# 1. OS packages (curl: dictionary download + healthcheck)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# 2. Hunspell dictionaries (own layer: network fetch, changes ~never).
#    The script fetches at the SAME pinned revision the curated license
#    data (scripts/curated-licenses.yaml) was verified against.
COPY backend/scripts/install-dictionaries.sh scripts/
RUN ./scripts/install-dictionaries.sh en de fr es it

# 3. Python runtime dependencies from the lockfile only
COPY backend/pyproject.toml backend/uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    VIRTUAL_ENV=/app/.venv
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv uv sync --locked --no-dev

# 4. spaCy pipelines + GiNZA from the SAME lockfile (largest, most stable
#    layer). Locked via the `models` dependency group, so ginza's
#    transitives (sudachipy, sudachidict-core, plac) cannot drift between
#    builds and the license inventory covers exactly what ships. This
#    layer sits below the lockfile COPY even though it changes less often,
#    because sync needs the project files from layer 3 — a dependency bump
#    therefore rebuilds it; the registry cache absorbs that for
#    unchanged-lockfile builds.
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv uv sync --locked --no-dev --group models

# 5. Application
COPY backend/app ./app
COPY backend/rules ./rules
COPY backend/demos ./demos
COPY docker/config.container.yaml ./config.container.yaml
COPY THIRD-PARTY-NOTICES.md LICENSE ./
COPY --from=frontend-build /build/dist ./dist
COPY --chmod=0755 docker/entrypoint.sh /entrypoint.sh

ARG APP_VERSION=dev
ENV FW_APP_VERSION=$APP_VERSION \
    FW_CONFIG_FILE=/config/config.yaml \
    PATH="/app/.venv/bin:$PATH"
LABEL org.opencontainers.image.source="https://github.com/saigyo/fabulous-writing" \
      org.opencontainers.image.description="Fabulous Writing — writing checker with LLM support" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$APP_VERSION

RUN useradd --create-home fabulous \
    && mkdir -p /data /config \
    && chown fabulous:fabulous /data /config
USER fabulous
VOLUME ["/data", "/config"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS http://localhost:8000/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["serve"]
