# Language-Routed Quality Tiers (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Writers pick a quality tier (`quality | balanced | cheap | local`) that a per-language routing table resolves to a concrete provider+model; profiles and the header become tier-first, with a pinned provider+model escape hatch in a collapsed "Advanced" panel; unavailable tiers are shown greyed out with the reason — never silent degradation.

**Architecture:** Phase 2 of `docs/superpowers/specs/2026-07-06-language-routed-models-design.md`. Backend: a `routing` config section with code-shipped defaults, a new `GET /api/routing` endpoint annotating per-tier availability, and a nullable `llm_tier` profile column (pin wins over tier wins over "no opinion"; existing rows behave identically). The check API is unchanged — the frontend resolves tier → concrete pair client-side (`checking/routing.ts`), consistent with client-side profile resolution.

**Tech Stack:** Backend Python 3.12/FastAPI/pydantic/pytest (uv). Frontend React 19/TS/zustand/vitest.

**Repo conventions:** Commits go directly on `main` (owner agreement); commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Backend tests: `cd backend && uv run pytest`. Frontend: `cd frontend && npm test -- --run`, `npm run lint`, `npm run build`.

**Two documented deviations from the spec** (settled during planning, record in the spec doc in Task 9):
1. *"Extract a shared availability helper"* — realized as a standalone status check inside the new routing module. `/api/providers` derives availability from its discovery calls and stays untouched; forcing one helper would either duplicate work or restructure discovery for no gain.
2. *Localized unavailability reasons* — reasons are backend-supplied English strings (`missing MISTRAL_API_KEY`, `Ollama not running`, `provider not configured`); the frontend wraps them in localized templates (`llmSkipped(reason)`) but does not translate the reason itself. Env-variable names and provider states read naturally in English; full localization would require reason *codes* across the API for marginal benefit.

---

### Task 1: Routing configuration (`routing` section with code-shipped defaults)

**Files:**
- Modify: `backend/app/core/config.py`
- Test: `backend/tests/test_config.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_config.py`:

```python
def test_routing_defaults_cover_all_languages_and_tiers() -> None:
    routing = Settings().routing
    assert routing.default_tier == "balanced"
    assert set(routing.languages) == {"en", "de", "fr", "es", "it", "ja", "zh"}
    for tiers in routing.languages.values():
        assert set(tiers) == {"quality", "balanced", "cheap", "local"}
    assert routing.languages["de"]["balanced"].provider == "mistral"
    assert routing.languages["zh"]["quality"].provider == "deepseek"
    assert routing.languages["en"]["local"].provider == "ollama"


def test_routing_user_override_replaces_only_that_language(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
routing:
  languages:
    de:
      balanced: { provider: openai, model: gpt-5-mini }
""",
        encoding="utf-8",
    )
    routing = load_settings(config).routing
    # de is replaced wholesale (only the tiers the user listed exist) ...
    assert set(routing.languages["de"]) == {"balanced"}
    assert routing.languages["de"]["balanced"].provider == "openai"
    # ... while every other language keeps its defaults.
    assert set(routing.languages["fr"]) == {"quality", "balanced", "cheap", "local"}


def test_routing_rejects_unknown_tier(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
routing:
  languages:
    en:
      premium: { provider: claude, model: claude-opus-4-8 }
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="tier"):
        load_settings(config)


def test_routing_rejects_unknown_language(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
routing:
  languages:
    xx:
      balanced: { provider: claude, model: claude-sonnet-5 }
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="language"):
        load_settings(config)


def test_routing_rejects_unknown_default_tier(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text("routing:\n  default_tier: premium\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="tier"):
        load_settings(config)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_config.py -v`
Expected: the five new tests FAIL (`Settings` has no attribute `routing`); existing tests PASS.

- [ ] **Step 3: Implement the routing settings**

In `backend/app/core/config.py`, add `model_validator` to the pydantic import line, then add below the `ExtraProviderSettings` block (above `NlpSettings`):

```python
# The four quality tiers, in UI order. Fixed — not user-definable.
TIERS = ("quality", "balanced", "cheap", "local")

# Kept as a literal (not imported from app.core.models) to avoid a config →
# models dependency for the sake of seven constant strings.
_LANGUAGE_CODES = ("en", "de", "fr", "es", "it", "ja", "zh")


class RoutingEntry(BaseModel):
    provider: str
    model: str


def _default_routing_languages() -> dict[str, dict[str, RoutingEntry]]:
    """Default tier table, from docs/model-recommendations.md §3-5.

    Entries may reference extra providers (deepseek, gemini, qwen) that are
    not configured — those tiers report as unavailable with a reason, which
    doubles as configuration guidance.
    """

    def entry(provider: str, model: str) -> RoutingEntry:
        return RoutingEntry(provider=provider, model=model)

    def european(balanced: RoutingEntry) -> dict[str, RoutingEntry]:
        return {
            "quality": entry("claude", "claude-opus-4-8"),
            "balanced": balanced,
            "cheap": entry("gemini", "models/gemini-flash-latest"),
            "local": entry("ollama", "mistral-nemo:12b-instruct-2407-q6_K"),
        }

    def cjk(quality: RoutingEntry, balanced: RoutingEntry) -> dict[str, RoutingEntry]:
        return {
            "quality": quality,
            "balanced": balanced,
            "cheap": entry("deepseek", "deepseek-v4-flash"),
            "local": entry("ollama", "qwen3:8b"),
        }

    return {
        "en": european(entry("claude", "claude-sonnet-5")),
        "de": european(entry("mistral", "mistral-large-latest")),
        "fr": european(entry("mistral", "mistral-large-latest")),
        "es": european(entry("mistral", "mistral-large-latest")),
        "it": european(entry("mistral", "mistral-large-latest")),
        "zh": cjk(entry("deepseek", "deepseek-v4-pro"), entry("qwen", "qwen3.7-max")),
        "ja": cjk(entry("qwen", "qwen3.7-max"), entry("qwen", "qwen3.6-plus")),
    }


class RoutingSettings(BaseModel):
    default_tier: str = "balanced"
    languages: dict[str, dict[str, RoutingEntry]] = Field(
        default_factory=_default_routing_languages
    )

    @model_validator(mode="before")
    @classmethod
    def _overlay_defaults(cls, data: object) -> object:
        # A user-supplied language replaces that language's whole tier map;
        # languages the user does not mention keep their defaults.
        if isinstance(data, dict):
            user = data.get("languages") or {}
            defaults = {
                lang: tiers
                for lang, tiers in _default_routing_languages().items()
                if lang not in user
            }
            data = {**data, "languages": {**defaults, **user}}
        return data

    @field_validator("default_tier")
    @classmethod
    def _check_default_tier(cls, value: str) -> str:
        if value not in TIERS:
            raise ValueError(f"unknown tier '{value}': must be one of {TIERS}")
        return value

    @field_validator("languages")
    @classmethod
    def _check_languages(
        cls, value: dict[str, dict[str, RoutingEntry]]
    ) -> dict[str, dict[str, RoutingEntry]]:
        for lang, tiers in value.items():
            if lang not in _LANGUAGE_CODES:
                raise ValueError(
                    f"unknown language '{lang}': must be one of {_LANGUAGE_CODES}"
                )
            for tier in tiers:
                if tier not in TIERS:
                    raise ValueError(
                        f"unknown tier '{tier}' for {lang}: must be one of {TIERS}"
                    )
        return value
```

And add to `Settings`:

```python
    routing: RoutingSettings = Field(default_factory=RoutingSettings)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_config.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/core/config.py backend/tests/test_config.py
git commit -m "feat(config): language-routed tier table with shipped defaults

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `GET /api/routing` with per-tier availability

**Files:**
- Create: `backend/app/api/routing.py`
- Modify: `backend/app/main.py` (register router)
- Test: `backend/tests/test_routing_api.py` (new file)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_routing_api.py`:

```python
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checkers.llm import bedrock
from app.core.config import ExtraProviderSettings, ProviderSettings, Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    for key in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "MISTRAL_API_KEY",
        "DEEPSEEK_API_KEY",
        "GEMINI_API_KEY",
        "QWEN_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(bedrock, "credentials_available", lambda: False)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        providers=ProviderSettings(
            ollama_base_url="http://127.0.0.1:9",
            extra_providers={
                "deepseek": ExtraProviderSettings(
                    base_url="http://127.0.0.1:9/v1",
                    default_model="deepseek-v4-pro",
                )
            },
        ),
    )
    return TestClient(create_app(settings))


def test_routing_shape(client: TestClient) -> None:
    body = client.get("/api/routing").json()
    assert body["default_tier"] == "balanced"
    assert body["tiers"] == ["quality", "balanced", "cheap", "local"]
    assert set(body["languages"]) == {"en", "de", "fr", "es", "it", "ja", "zh"}
    entry = body["languages"]["de"]["balanced"]
    assert entry["provider"] == "mistral"
    assert entry["model"] == "mistral-large-latest"


def test_routing_reports_unavailability_reasons(client: TestClient) -> None:
    languages = client.get("/api/routing").json()["languages"]
    # API provider without a key.
    balanced_de = languages["de"]["balanced"]
    assert balanced_de["available"] is False
    assert balanced_de["reason"] == "missing MISTRAL_API_KEY"
    # Configured extra without a key.
    quality_zh = languages["zh"]["quality"]
    assert quality_zh["available"] is False
    assert quality_zh["reason"] == "missing DEEPSEEK_API_KEY"
    # Referenced provider that exists nowhere (gemini is not configured here).
    cheap_en = languages["en"]["cheap"]
    assert cheap_en["available"] is False
    assert cheap_en["reason"] == "provider not configured"
    # Ollama at an unreachable address.
    local_en = languages["en"]["local"]
    assert local_en["available"] is False
    assert local_en["reason"] == "Ollama not running"


def test_routing_reports_available_with_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISTRAL_API_KEY", "sk-test")
    entry = client.get("/api/routing").json()["languages"]["de"]["balanced"]
    assert entry["available"] is True
    assert entry["reason"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_routing_api.py -v`
Expected: all three FAIL with 404 (no `/api/routing` route).

- [ ] **Step 3: Implement the routing endpoint**

Create `backend/app/api/routing.py`:

```python
import asyncio
import os
from typing import Any

from fastapi import APIRouter, Request

from app.checkers.llm import bedrock
from app.checkers.llm.ollama import OllamaProvider
from app.core.config import TIERS, ProviderSettings

router = APIRouter(prefix="/api", tags=["routing"])

_PING_TIMEOUT = 3.0

# Env variable per built-in API provider (extras derive theirs by name).
_BUILTIN_ENV_KEYS = {
    "claude": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
}


async def _provider_status(
    settings: ProviderSettings, name: str
) -> tuple[bool, str | None]:
    """Cheap availability check (no model discovery) with a human-readable reason."""
    if name == "ollama":
        provider = OllamaProvider(
            base_url=settings.ollama_base_url, model=settings.ollama_model
        )
        try:
            async with asyncio.timeout(_PING_TIMEOUT):
                await provider.list_models()
            return True, None
        except Exception:
            return False, "Ollama not running"
    if name == "bedrock":
        available = await asyncio.to_thread(bedrock.credentials_available)
        return (True, None) if available else (False, "AWS credentials not available")
    env_key = _BUILTIN_ENV_KEYS.get(name)
    if env_key is None and name in settings.extra_providers:
        env_key = f"{name.upper()}_API_KEY"
    if env_key is None:
        return False, "provider not configured"
    if os.environ.get(env_key):
        return True, None
    return False, f"missing {env_key}"


@router.get("/routing")
async def get_routing(request: Request) -> dict[str, Any]:
    settings = request.app.state.settings
    routing = settings.routing
    names = sorted(
        {
            entry.provider
            for tiers in routing.languages.values()
            for entry in tiers.values()
        }
    )
    results = await asyncio.gather(
        *(_provider_status(settings.providers, name) for name in names)
    )
    status = dict(zip(names, results))
    languages = {
        lang: {
            tier: {
                "provider": entry.provider,
                "model": entry.model,
                "available": status[entry.provider][0],
                "reason": status[entry.provider][1],
            }
            for tier, entry in tiers.items()
        }
        for lang, tiers in routing.languages.items()
    }
    return {
        "default_tier": routing.default_tier,
        "tiers": list(TIERS),
        "languages": languages,
    }
```

In `backend/app/main.py`: add `from app.api.routing import router as routing_router` to the imports (alphabetical, after the rules import line) and `app.include_router(routing_router)` beside the other `include_router` calls.

- [ ] **Step 4: Run the tests, then the full backend suite**

Run: `cd backend && uv run pytest tests/test_routing_api.py -v` — all PASS.
Run: `cd backend && uv run pytest` — full suite PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/routing.py backend/app/main.py backend/tests/test_routing_api.py
git commit -m "feat(api): GET /api/routing with per-tier availability

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Profile `llm_tier` column, API validation, tier-first seeding

**Files:**
- Modify: `backend/app/services/profiles.py`
- Modify: `backend/app/api/profiles.py`
- Modify: `backend/app/services/seed_profiles.py`
- Modify: `backend/app/main.py` (seed call signature)
- Test: `backend/tests/test_profiles.py`, `backend/tests/test_profiles_api.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_profiles.py` (top section, near the other store tests — `make_store` helper exists in that file; if it is named differently, reuse whatever fixture the neighboring tests use to build a `ProfileStore` on `tmp_path`):

```python
def test_llm_tier_roundtrip(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "p.db")
    p = store.create_profile(Language.EN, "Blog", llm_tier="quality")
    assert store.get_profile(p.id).llm_tier == "quality"
    updated = store.update_profile(p.id, llm_tier=None)
    assert updated.llm_tier is None


def test_llm_tier_column_migration_is_idempotent(tmp_path: Path) -> None:
    # Opening the store twice must not fail on the ALTER TABLE guard.
    ProfileStore(tmp_path / "p.db")
    store = ProfileStore(tmp_path / "p.db")
    assert store.create_profile(Language.EN, "X", llm_tier="local").llm_tier == "local"
```

In the seeding section of `backend/tests/test_profiles.py`, update every `seed_profiles(store, DEMOS, default_provider="ollama", seed_examples=...)` call to `seed_profiles(store, DEMOS, seed_examples=...)` (the parameter goes away), and change the assertion at line ~75 from

```python
        assert std.llm_provider == "ollama" and std.llm_model is None
```

to

```python
        assert std.llm_provider is None and std.llm_model is None
        assert std.llm_tier == "balanced"
```

Append to `backend/tests/test_profiles_api.py` (that file builds its `TestClient` via a fixture/helper — follow its existing pattern):

```python
def test_profile_accepts_llm_tier(client: TestClient) -> None:
    created = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Tiered", "llm_tier": "cheap"},
    ).json()
    assert created["llm_tier"] == "cheap"
    updated = client.put(
        f"/api/profiles/{created['id']}",
        json={
            "name": "Tiered",
            "categories_off": [],
            "rule_exceptions": [],
            "domain_ids": [],
            "llm_provider": None,
            "llm_model": None,
            "llm_tier": "quality",
            "llm_instructions": "",
            "example_text": "",
        },
    ).json()
    assert updated["llm_tier"] == "quality"


def test_profile_rejects_unknown_tier(client: TestClient) -> None:
    response = client.post(
        "/api/profiles",
        json={"language": "en", "name": "Bad", "llm_tier": "premium"},
    )
    assert response.status_code == 422
```

Note: if `test_profiles_api.py` has no shared `client` fixture, create the client inline exactly as the neighboring tests do. If the existing PUT tests send bodies without `llm_tier`, they keep working (the field defaults to `None` on create; for `ProfileUpdate` add it with a `None` default — see Step 3 — so old payload shapes stay valid).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_profiles.py tests/test_profiles_api.py -v`
Expected: new tests FAIL (`llm_tier` unexpected argument / missing field); the updated seeding tests FAIL (`seed_profiles` still requires `default_provider`).

- [ ] **Step 3: Implement**

`backend/app/services/profiles.py`:

1. In `_SCHEMA`, add a line after `llm_model TEXT,`:

```sql
    llm_tier TEXT,
```

2. In `__init__`, after `conn.executescript(_SCHEMA)` add (still inside the `with`):

```python
            self._migrate(conn)
```

and add the method to `ProfileStore`:

```python
    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(profiles)")}
        if "llm_tier" not in columns:
            conn.execute("ALTER TABLE profiles ADD COLUMN llm_tier TEXT")
```

3. `Profile` model: add `llm_tier: str | None = None` after `llm_model`.
4. `_row_to_profile`: add `llm_tier=row["llm_tier"],`.
5. `create_profile`: add keyword parameter `llm_tier: str | None = None`, add `llm_tier` to the INSERT column list, placeholder tuple (after `llm_model`), and value tuple.
6. `_UPDATABLE`: add `"llm_tier"`.
7. `update_profile` UPDATE statement: add `llm_tier = ?` after `llm_model = ?` and `merged.llm_tier` in the parameter tuple.

`backend/app/api/profiles.py`:

1. Add `from typing import Literal` to the imports.
2. Add to **both** `ProfileCreate` and `ProfileUpdate`:

```python
    llm_tier: Literal["quality", "balanced", "cheap", "local"] | None = None
```

(pydantic turns an unknown tier into an automatic 422.)
3. Pass `llm_tier=body.llm_tier` through in `create_profile` and `update_profile` (next to `llm_model`).
4. `reset_profile`: change the `standard_defaults(...)` call to `standard_defaults(profile.language, settings.demos_dir)` (parameter removed below).

`backend/app/services/seed_profiles.py`:

1. `standard_defaults` loses the `default_provider` parameter and seeds tier-first:

```python
def standard_defaults(language: Language, demos_dir: Path) -> dict:
    """Factory defaults for a language's Standard profile (also used by reset)."""
    return {
        "categories_off": [],
        "rule_exceptions": [],
        "domain_ids": [],
        "llm_tier": "balanced",
        "llm_provider": None,
        "llm_model": None,
        "llm_instructions": "",
        "example_text": _demo(demos_dir, f"{language.value}.txt"),
    }
```

2. `seed_profiles` loses `default_provider` (signature: `seed_profiles(store, demos_dir, *, seed_examples: bool)`); the Standard call becomes `**standard_defaults(language, demos_dir)`; in the Marketing and Technical Documentation seeds replace `llm_provider=default_provider,` with `llm_tier="balanced",`.

`backend/app/main.py`: the `seed_profiles(...)` call drops the `default_provider=` argument.

- [ ] **Step 4: Run the tests, then the full backend suite**

Run: `cd backend && uv run pytest tests/test_profiles.py tests/test_profiles_api.py -v` — all PASS.
Run: `cd backend && uv run pytest` — full suite PASS (watch for other tests constructing seed calls or asserting profile JSON shapes; update them the same way if any fail).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/profiles.py backend/app/api/profiles.py backend/app/services/seed_profiles.py backend/app/main.py backend/tests/test_profiles.py backend/tests/test_profiles_api.py
git commit -m "feat(profiles): nullable llm_tier column; tier-first seeding

Pin wins over tier wins over no-opinion; existing rows keep their
pinned provider, fresh seeds get tier=balanced with no pin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend types, API client, store (tier state + pin semantics)

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/state/store.ts`
- Test: `frontend/src/state/store.test.ts` (create if it does not exist; if a store test file exists under another name, extend that one)

- [ ] **Step 1: Write the failing tests**

Add to the store test file:

```typescript
import { describe, expect, it } from 'vitest'
import { useStore } from './store'

describe('tier / pin semantics', () => {
  it('setTier enters tier mode', () => {
    useStore.getState().setTier('quality')
    expect(useStore.getState().tier).toBe('quality')
  })

  it('choosing a provider pins (clears the tier)', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setProvider('claude')
    expect(useStore.getState().tier).toBeNull()
    expect(useStore.getState().provider).toBe('claude')
    expect(useStore.getState().model).toBeNull()
  })

  it('choosing a model pins (clears the tier)', () => {
    useStore.getState().setTier('balanced')
    useStore.getState().setModel('claude-opus-4-8')
    expect(useStore.getState().tier).toBeNull()
    expect(useStore.getState().model).toBe('claude-opus-4-8')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npm test -- --run src/state`
Expected: FAIL (`setTier` does not exist / `tier` undefined).

- [ ] **Step 3: Implement**

`frontend/src/types.ts` — append:

```typescript
export type Tier = 'quality' | 'balanced' | 'cheap' | 'local'

export const TIERS: Tier[] = ['quality', 'balanced', 'cheap', 'local']

export interface RoutingEntry {
  provider: string
  model: string
  available: boolean
  reason: string | null
}

export interface RoutingTable {
  default_tier: Tier
  tiers: Tier[]
  languages: Partial<Record<Language, Partial<Record<Tier, RoutingEntry>>>>
}
```

and add to the `Profile` interface (after `llm_model`):

```typescript
  llm_tier: Tier | null
```

`frontend/src/api/client.ts` — add `RoutingTable` to the type import from `../types` and, next to `getProviders`:

```typescript
export const getRouting = () => request<RoutingTable>('/api/routing')
```

`frontend/src/state/store.ts`:

1. Add `Tier` and `RoutingTable` to the type import from `../types`.
2. `AppState` gains (after `model: string | null`):

```typescript
  // null = pinned to provider/model; non-null = tier mode.
  tier: Tier | null
```

and (after `providers: ProviderInfo[]`):

```typescript
  routing: RoutingTable | null
```

and the actions:

```typescript
  setTier: (tier: Tier) => void
  setRouting: (routing: RoutingTable | null) => void
```

3. Initial values: `tier: 'balanced',` (fresh installs are tier-first) and `routing: null,`.
4. Actions — **pinning is choosing a concrete provider or model**:

```typescript
      setProvider: (provider) => set({ provider, model: null, tier: null }),
      setModel: (model) => set({ model, tier: null }),
      setTier: (tier) => set({ tier }),
      setRouting: (routing) => set({ routing }),
```

5. Persistence: add `tier: state.tier,` to `partialize`, and version the store so **existing** users keep their pinned provider instead of silently flipping to tier mode:

```typescript
    {
      name: 'fabulous-writing-settings',
      version: 1,
      // v0 predates tiers: those users had explicitly chosen provider/model,
      // so they stay pinned rather than silently switching models.
      migrate: (persisted, version) =>
        version === 0
          ? { ...(persisted as object), tier: null }
          : (persisted as object),
      partialize: (state) => ({
        language: state.language,
        uiLocale: state.uiLocale,
        domainIds: state.domainIds,
        provider: state.provider,
        model: state.model,
        tier: state.tier,
        llmAuto: state.llmAuto,
        lastProfileByLanguage: state.lastProfileByLanguage,
      }),
    },
```

Note: `applyProfileToHeader` changes shape in Task 6; until then the existing call in `selectProfile` still compiles (it returns an object that is spread). If TypeScript complains about the `HeaderSettings` return not mentioning `tier`, leave it — Task 6 fixes the signature; run only the store tests in this task.

- [ ] **Step 4: Run to verify green**

Run: `cd frontend && npm test -- --run src/state` — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts frontend/src/state/store.ts frontend/src/state/store.test.ts
git commit -m "feat(store): tier state with pin semantics and persisted-store migration

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `resolveModel` + wiring into check controller and suggestions

**Files:**
- Create: `frontend/src/checking/routing.ts`
- Create: `frontend/src/checking/routing.test.ts`
- Modify: `frontend/src/checking/controller.ts`
- Modify: `frontend/src/checking/suggest.ts`
- Modify: `frontend/src/sidebar/Sidebar.tsx` (render `llmError` raw — see Step 3.4)

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/checking/routing.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { ProviderInfo, RoutingTable } from '../types'
import { resolveModel } from './routing'

const providers: ProviderInfo[] = [
  { name: 'claude', available: true, models: ['claude-sonnet-5'], default_model: 'claude-sonnet-5' },
]

const routing: RoutingTable = {
  default_tier: 'balanced',
  tiers: ['quality', 'balanced', 'cheap', 'local'],
  languages: {
    de: {
      balanced: { provider: 'mistral', model: 'mistral-large-latest', available: true, reason: null },
      quality: { provider: 'claude', model: 'claude-opus-4-8', available: false, reason: 'missing ANTHROPIC_API_KEY' },
    },
  },
}

describe('resolveModel', () => {
  it('pinned mode returns the pair, model falling back to the provider default', () => {
    const result = resolveModel({
      tier: null, provider: 'claude', model: null, language: 'de', providers, routing,
    })
    expect(result).toEqual({ ok: true, provider: 'claude', model: 'claude-sonnet-5' })
  })

  it('tier mode resolves through the routing table', () => {
    const result = resolveModel({
      tier: 'balanced', provider: 'claude', model: null, language: 'de', providers, routing,
    })
    expect(result).toEqual({ ok: true, provider: 'mistral', model: 'mistral-large-latest' })
  })

  it('unavailable tier reports the reason', () => {
    const result = resolveModel({
      tier: 'quality', provider: 'claude', model: null, language: 'de', providers, routing,
    })
    expect(result).toEqual({ ok: false, reason: 'missing ANTHROPIC_API_KEY' })
  })

  it('missing tier or language reports not configured', () => {
    expect(
      resolveModel({ tier: 'cheap', provider: 'claude', model: null, language: 'de', providers, routing }),
    ).toEqual({ ok: false, reason: 'not configured' })
    expect(
      resolveModel({ tier: 'balanced', provider: 'claude', model: null, language: 'en', providers, routing }),
    ).toEqual({ ok: false, reason: 'not configured' })
  })

  it('missing routing table reports not configured', () => {
    expect(
      resolveModel({ tier: 'balanced', provider: 'claude', model: null, language: 'de', providers, routing: null }),
    ).toEqual({ ok: false, reason: 'not configured' })
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `cd frontend && npm test -- --run src/checking/routing.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

1. Create `frontend/src/checking/routing.ts`:

```typescript
import type { Language, ProviderInfo, RoutingTable, Tier } from '../types'
import { effectiveModel } from './model'

export type Resolution =
  | { ok: true; provider: string; model: string | null }
  | { ok: false; reason: string }

/**
 * Resolve the header's LLM choice to a concrete provider+model. Pinned mode
 * (tier === null) uses the explicit pair; tier mode looks the language up in
 * the routing table. An unavailable or missing entry is an explicit failure
 * — the LLM check is skipped with the reason, never silently degraded.
 */
export function resolveModel(state: {
  tier: Tier | null
  provider: string
  model: string | null
  language: Language
  providers: ProviderInfo[]
  routing: RoutingTable | null
}): Resolution {
  if (state.tier === null) {
    return {
      ok: true,
      provider: state.provider,
      model: effectiveModel(state.model, state.provider, state.providers),
    }
  }
  const entry = state.routing?.languages[state.language]?.[state.tier]
  if (!entry) return { ok: false, reason: 'not configured' }
  if (!entry.available) return { ok: false, reason: entry.reason ?? 'unavailable' }
  return { ok: true, provider: entry.provider, model: entry.model }
}
```

2. `frontend/src/checking/controller.ts` — imports gain `currentMessages` from `'../i18n'` and `resolveModel` from `'./routing'`; the `effectiveModel` import is removed. Inside `runCheck`, after `const text = ...`, add:

```typescript
  const resolution = resolveModel(state)
```

Change the checkers/status block to skip the LLM explicitly when unresolvable:

```typescript
  const wantLlm = includeLlm && resolution.ok
  const checkers = wantLlm
    ? ['rules', 'terminology', 'llm']
    : ['rules', 'terminology']
  useStore.setState({
    checkPhase: wantLlm ? 'llm' : 'fast',
    llmError:
      includeLlm && !resolution.ok
        ? currentMessages().llmSkipped(resolution.reason)
        : includeLlm
          ? null
          : state.llmError,
    llmStartedAt: wantLlm ? Date.now() : null,
    llmTokens: null,
  })
```

In the `postCheck` body replace the two LLM lines with:

```typescript
      llm_provider: resolution.ok ? resolution.provider : null,
      llm_model: resolution.ok ? resolution.model : null,
```

Change the guard after applying fast findings from `if (!includeLlm || result.status === 'done')` to `if (!wantLlm || result.status === 'done')`.

Wrap the two error strings in localized templates (they are now rendered raw — see item 4):

- in the `catch` around `postCheck`: `llmError: currentMessages().llmCheckFailed(String(error)),`
- in `onError`: `useStore.setState({ llmError: currentMessages().llmCheckFailed(error) })`

3. `frontend/src/checking/suggest.ts` — import `resolveModel` from `'./routing'` (replacing the `effectiveModel` import). In `requestForFinding`, before the `postSuggestions` call:

```typescript
  const resolution = resolveModel(state)
  if (!resolution.ok) {
    throw new Error(currentMessages().llmSkipped(resolution.reason))
  }
```

and in the request body:

```typescript
    llm_provider: resolution.provider,
    llm_model: resolution.model,
```

In `fetchSuggestions` and `fetchRewrite`, change the catch handlers from `String(error)` to `error instanceof Error ? error.message : String(error)` so the skip message is not prefixed with `Error:`.

4. `frontend/src/sidebar/Sidebar.tsx` line ~128: `llmError` now stores complete localized messages, so change

```tsx
      {llmError && <div className="llm-error">{m.llmCheckFailed(llmError)}</div>}
```

to

```tsx
      {llmError && <div className="llm-error">{llmError}</div>}
```

(`m` may become unused in that component scope — remove the unused binding only if lint flags it.)

Note: `llmSkipped` does not exist until Task 6 adds it to the catalogs. To keep this task green, Task 6 and this task are committed **together** — do Task 6 Step 3 (the `messages.ts` + catalog additions) before running this task's full-suite check, or execute Tasks 5 and 6 as one working session with two commits at the end in dependency order (i18n first). The plan orders the i18n additions as Task 6 for reviewability; the executor should implement 5 and 6 before running `npm test` for either.

- [ ] **Step 4: Run to verify green (after Task 6's catalogs exist)**

Run: `cd frontend && npm test -- --run` — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/checking/routing.ts frontend/src/checking/routing.test.ts frontend/src/checking/controller.ts frontend/src/checking/suggest.ts frontend/src/sidebar/Sidebar.tsx
git commit -m "feat(checking): client-side tier resolution; explicit LLM skip on unavailable tier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: i18n keys for tiers (all seven catalogs)

**Files:**
- Modify: `frontend/src/i18n/messages.ts`
- Modify: `frontend/src/i18n/{en,de,fr,es,it,ja,zh}.ts`

- [ ] **Step 1: Add the keys to the `Messages` interface**

In `frontend/src/i18n/messages.ts`, add `Tier` to the type import from `'../types'` and append to the Header section of the interface:

```typescript
  tierName: (tier: Tier) => string
  tierPinnedOption: (model: string) => string
  resolvedModel: (model: string, provider: string) => string
  advanced: string
  pinnedNote: string
  clearPin: string
  llmSkipped: (reason: string) => string
```

- [ ] **Step 2: Add the entries to every catalog**

The keys-equality vitest test fails until all seven catalogs have them. Exact entries:

`en.ts`:

```typescript
  tierName: (t) =>
    ({ quality: 'Best quality', balanced: 'Balanced', cheap: 'Fast & economical', local: 'Private (local)' })[t],
  tierPinnedOption: (model) => `Pinned: ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Advanced',
  pinnedNote: 'A pinned model overrides the tiers',
  clearPin: 'Clear pin',
  llmSkipped: (reason) => `LLM check skipped: ${reason}`,
```

`de.ts`:

```typescript
  tierName: (t) =>
    ({ quality: 'Beste Qualität', balanced: 'Ausgewogen', cheap: 'Schnell & günstig', local: 'Privat (lokal)' })[t],
  tierPinnedOption: (model) => `Festgelegt: ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Erweitert',
  pinnedNote: 'Ein festgelegtes Modell übersteuert die Stufen',
  clearPin: 'Festlegung aufheben',
  llmSkipped: (reason) => `LLM-Prüfung übersprungen: ${reason}`,
```

`fr.ts`:

```typescript
  tierName: (t) =>
    ({ quality: 'Meilleure qualité', balanced: 'Équilibré', cheap: 'Rapide et économique', local: 'Privé (local)' })[t],
  tierPinnedOption: (model) => `Épinglé : ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Avancé',
  pinnedNote: 'Un modèle épinglé remplace les niveaux',
  clearPin: "Retirer l'épingle",
  llmSkipped: (reason) => `Vérification LLM ignorée : ${reason}`,
```

`es.ts`:

```typescript
  tierName: (t) =>
    ({ quality: 'Máxima calidad', balanced: 'Equilibrado', cheap: 'Rápido y económico', local: 'Privado (local)' })[t],
  tierPinnedOption: (model) => `Fijado: ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Avanzado',
  pinnedNote: 'Un modelo fijado anula los niveles',
  clearPin: 'Quitar fijación',
  llmSkipped: (reason) => `Comprobación LLM omitida: ${reason}`,
```

`it.ts`:

```typescript
  tierName: (t) =>
    ({ quality: 'Migliore qualità', balanced: 'Bilanciato', cheap: 'Veloce ed economico', local: 'Privato (locale)' })[t],
  tierPinnedOption: (model) => `Fissato: ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: 'Avanzate',
  pinnedNote: 'Un modello fissato ha la precedenza sui livelli',
  clearPin: 'Rimuovi il blocco',
  llmSkipped: (reason) => `Controllo LLM saltato: ${reason}`,
```

`ja.ts`:

```typescript
  tierName: (t) =>
    ({ quality: '最高品質', balanced: 'バランス', cheap: '高速・低コスト', local: 'プライベート(ローカル)' })[t],
  tierPinnedOption: (model) => `固定: ${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: '詳細設定',
  pinnedNote: '固定モデルがティアより優先されます',
  clearPin: '固定を解除',
  llmSkipped: (reason) => `LLM チェックをスキップ: ${reason}`,
```

`zh.ts`:

```typescript
  tierName: (t) =>
    ({ quality: '最佳质量', balanced: '均衡', cheap: '快速经济', local: '私密(本地)' })[t],
  tierPinnedOption: (model) => `固定:${model}`,
  resolvedModel: (model, provider) => `→ ${model} (${provider})`,
  advanced: '高级设置',
  pinnedNote: '固定模型优先于级别',
  clearPin: '取消固定',
  llmSkipped: (reason) => `已跳过 LLM 检查:${reason}`,
```

Match each catalog's existing entry style (place the new keys next to the other header keys, keep the trailing-comma style). If a catalog's parameterized entries annotate parameter types explicitly, do the same (`(t: Tier) =>` etc.).

- [ ] **Step 3: Run the i18n test**

Run: `cd frontend && npm test -- --run src/i18n` — the keys-equality test PASSES.

- [ ] **Step 4: Commit** (after Task 5 is also green — see the note there)

```bash
git add frontend/src/i18n
git commit -m "feat(i18n): tier names and pin/skip messages in all seven locales

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Header — tier-first LLM selector with collapsed Advanced panel

**Files:**
- Create: `frontend/src/header/LlmSelector.tsx`
- Modify: `frontend/src/App.tsx` (fetch routing, replace the LLM/model labels)
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Create the component**

Create `frontend/src/header/LlmSelector.tsx`:

```tsx
import { resolveModel } from '../checking/routing'
import { useMessages } from '../i18n'
import { useStore } from '../state/store'
import { TIERS, type Tier } from '../types'

/**
 * Tier-first LLM selection: the visible control is a quality-tier dropdown
 * with the resolved model shown beneath; the concrete provider/model
 * dropdowns live in a collapsed Advanced panel and act as a pin (tier mode
 * off) — mirroring the profile editor. Unavailable tiers are disabled with
 * the reason, never silently degraded.
 */
export function LlmSelector() {
  const store = useStore()
  const m = useMessages()
  const entryFor = (tier: Tier) => store.routing?.languages[store.language]?.[tier]
  const resolution = resolveModel(store)
  const activeProvider = store.providers.find((p) => p.name === store.provider)
  const pinned = store.tier === null

  return (
    <div className="llm-selector">
      <label>
        {m.llm}
        <select
          value={store.tier ?? 'pinned'}
          onChange={(e) => {
            if (e.target.value !== 'pinned') store.setTier(e.target.value as Tier)
          }}
        >
          {TIERS.map((tier) => {
            const entry = entryFor(tier)
            const unavailable = !entry || !entry.available
            return (
              <option key={tier} value={tier} disabled={unavailable}>
                {m.tierName(tier)}
                {unavailable ? m.offlineSuffix : ''}
              </option>
            )
          })}
          {pinned && (
            <option value="pinned">
              {m.tierPinnedOption(
                store.model ?? activeProvider?.default_model ?? store.provider,
              )}
            </option>
          )}
        </select>
      </label>
      <span
        className={`llm-resolved${resolution.ok ? '' : ' llm-resolved-error'}`}
        title={resolution.ok ? undefined : resolution.reason}
      >
        {resolution.ok
          ? m.resolvedModel(resolution.model ?? '', resolution.provider)
          : m.llmSkipped(resolution.reason)}
      </span>
      <details className="llm-advanced">
        <summary>{m.advanced}</summary>
        <div className="llm-advanced-body">
          <label>
            {m.llm}
            <select
              value={store.provider}
              onChange={(e) => store.setProvider(e.target.value)}
            >
              {store.providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.name}
                  {provider.available ? '' : m.offlineSuffix}
                </option>
              ))}
            </select>
          </label>
          <label>
            {m.model}
            <select
              value={store.model ?? activeProvider?.default_model ?? ''}
              onChange={(e) => store.setModel(e.target.value)}
            >
              {(activeProvider?.models.length
                ? activeProvider.models
                : [activeProvider?.default_model ?? '']
              ).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

1. Imports: add `getRouting` to the `./api/client` import; add `import { LlmSelector } from './header/LlmSelector'`; remove nothing else yet.
2. In the mount `useEffect` (line ~44), add:

```typescript
    getRouting().then(store.setRouting).catch(() => store.setRouting(null))
```

3. Replace the two `<label>` blocks for LLM and model (lines ~125-154, from `<label>` `{m.llm}` through the closing `</label>` of the model select) with:

```tsx
        <LlmSelector />
```

4. Remove the now-unused `const activeProvider = ...` line (~72) from `Header`.

- [ ] **Step 3: Styles**

Append to `frontend/src/App.css`:

```css
.llm-selector {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: relative;
}

.llm-resolved {
  font-size: 0.72rem;
  color: #667;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.llm-resolved-error {
  color: #b3261e;
}

.llm-advanced summary {
  font-size: 0.72rem;
  color: #667;
  cursor: pointer;
  user-select: none;
}

.llm-advanced[open] .llm-advanced-body {
  position: absolute;
  z-index: 10;
  top: 100%;
  right: 0;
  display: flex;
  gap: 8px;
  padding: 10px;
  background: #fff;
  border: 1px solid #d8d8e0;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(20, 20, 40, 0.12);
}
```

Match the file's existing color variables/conventions if it uses CSS custom properties — reuse those instead of the literals above.

- [ ] **Step 4: Verify**

Run: `cd frontend && npm test -- --run && npm run lint && npm run build` — all clean.
Manual smoke (dev servers running): header shows the tier dropdown with "Balanced" and the resolved model caption; unavailable tiers greyed out with reason on hover; opening Advanced and picking a provider switches the dropdown to "Pinned: …"; picking a tier again leaves pinned mode.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/header/LlmSelector.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(header): tier-first LLM selector with collapsed advanced pin panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Profile semantics — mode-aware apply/dirty/save + ProfilesView tier UI

**Files:**
- Modify: `frontend/src/profiles/profile.ts`
- Modify: `frontend/src/profiles/profile.test.ts` (extend; the file exists)
- Modify: `frontend/src/state/store.ts` (the `applyProfileToHeader` call site)
- Modify: `frontend/src/header/ProfileSelector.tsx`
- Modify: `frontend/src/profiles/ProfilesView.tsx`
- Modify: `frontend/src/rules/RulesView.tsx` (PUT payload must carry `llm_tier` — see Step 5b)
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Write the failing tests**

In `frontend/src/profiles/profile.test.ts`, the existing tests construct `Profile` objects and `HeaderSettings`; extend the profile factory/fixtures with `llm_tier: null` where object literals now miss the field, then append:

```typescript
describe('tier-aware profile semantics', () => {
  const base = {
    id: 1, language: 'en' as const, name: 'P', is_standard: false,
    categories_off: [], rule_exceptions: [], domain_ids: [],
    llm_instructions: '', example_text: '',
  }
  const pinnedProfile = { ...base, llm_provider: 'claude', llm_model: 'claude-sonnet-5', llm_tier: null }
  const tierProfile = { ...base, llm_provider: null, llm_model: null, llm_tier: 'quality' as const }
  const noOpinion = { ...base, llm_provider: null, llm_model: null, llm_tier: null }

  it('applyProfileToHeader: pin wins over tier', () => {
    expect(applyProfileToHeader({ ...pinnedProfile, llm_tier: 'cheap' })).toEqual({
      domainIds: [], tier: null, provider: 'claude', model: 'claude-sonnet-5',
    })
  })

  it('applyProfileToHeader: tier profile applies the tier only', () => {
    expect(applyProfileToHeader(tierProfile)).toEqual({ domainIds: [], tier: 'quality' })
  })

  it('applyProfileToHeader: no opinion leaves LLM fields untouched', () => {
    expect(applyProfileToHeader(noOpinion)).toEqual({ domainIds: [] })
  })

  it('isProfileDirty: tier profile vs matching header is clean', () => {
    expect(isProfileDirty(tierProfile, {
      domainIds: [], tier: 'quality', provider: 'ollama', model: null,
    })).toBe(false)
  })

  it('isProfileDirty: tier profile vs different tier or pinned header is dirty', () => {
    expect(isProfileDirty(tierProfile, {
      domainIds: [], tier: 'balanced', provider: 'ollama', model: null,
    })).toBe(true)
    expect(isProfileDirty(tierProfile, {
      domainIds: [], tier: null, provider: 'ollama', model: null,
    })).toBe(true)
  })

  it('isProfileDirty: pinned profile vs tier-mode header is dirty', () => {
    expect(isProfileDirty(pinnedProfile, {
      domainIds: [], tier: 'balanced', provider: 'claude', model: 'claude-sonnet-5',
    })).toBe(true)
  })

  it('isProfileDirty: no-opinion profile never dirty on LLM fields', () => {
    expect(isProfileDirty(noOpinion, {
      domainIds: [], tier: 'quality', provider: 'claude', model: 'x',
    })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify red**

Run: `cd frontend && npm test -- --run src/profiles` — new tests FAIL (shape mismatch); some existing ones may fail on the changed signature — that is expected until Step 3.

- [ ] **Step 3: Implement `profile.ts`**

Replace `HeaderSettings`, `applyProfileToHeader`, and `isProfileDirty` in `frontend/src/profiles/profile.ts` (imports gain `Tier` from `'../types'`):

```typescript
export interface HeaderSettings {
  domainIds: number[]
  tier: Tier | null
  provider: string
  model: string | null
}

/**
 * Header values a profile selection implies. Pin wins over tier wins over
 * "no opinion" (both null: the header's LLM settings stay untouched).
 */
export function applyProfileToHeader(profile: Profile): {
  domainIds: number[]
  tier?: Tier | null
  provider?: string
  model?: string | null
} {
  const base = { domainIds: [...profile.domain_ids] }
  if (profile.llm_provider !== null) {
    return {
      ...base,
      tier: null,
      provider: profile.llm_provider,
      model: profile.llm_model,
    }
  }
  if (profile.llm_tier !== null) return { ...base, tier: profile.llm_tier }
  return base
}

/** True when the header selectors differ from the stored profile. */
export function isProfileDirty(profile: Profile, header: HeaderSettings): boolean {
  const a = new Set(profile.domain_ids)
  const b = new Set(header.domainIds)
  if (a.size !== b.size || [...a].some((id) => !b.has(id))) return true
  if (profile.llm_provider !== null) {
    return (
      header.tier !== null ||
      profile.llm_provider !== header.provider ||
      (profile.llm_model ?? null) !== (header.model ?? null)
    )
  }
  if (profile.llm_tier !== null) return header.tier !== profile.llm_tier
  // No LLM opinion recorded — the header's LLM settings are never dirty.
  return false
}
```

Update the call site in `frontend/src/state/store.ts` `selectProfile`: `applyProfileToHeader(profile, state.provider)` → `applyProfileToHeader(profile)`.

Fix any pre-existing tests in `profile.test.ts` that break on the new shapes: add `tier: null` to `HeaderSettings` literals, `llm_tier: null` to `Profile` literals, and drop the second `applyProfileToHeader` argument. Where an old test asserted the removed fallback (`provider: currentProvider ?? 'ollama'` for a null-provider profile), replace the expectation with the new partial-return behavior.

- [ ] **Step 4: `ProfileSelector.tsx`**

Add `const tier = useStore((s) => s.tier)` beside the other hooks; extend the dirty call to `isProfileDirty(selected, { domainIds, tier, provider, model })`; in `saveOverrides` replace the two LLM lines with the mode mapping:

```typescript
      llm_tier: tier,
      llm_provider: tier === null ? provider : null,
      llm_model: tier === null ? model : null,
```

(`ProfilePayload` picks `llm_tier` up automatically from the extended `Profile` type.)

- [ ] **Step 5: `ProfilesView.tsx` — tier selector + Advanced panel per card**

1. Import `TIERS, type Tier` from `'../types'`.
2. In `create()`, replace the two LLM lines with:

```typescript
        llm_tier: state.tier,
        llm_provider: state.tier === null ? state.provider : null,
        llm_model: state.tier === null ? state.model : null,
```

3. In `ProfileCard`, replace the whole `<div className="profile-card-llm">…</div>` block with:

```tsx
        <div className="profile-card-llm">
          <span className="field-label">{m.llm}</span>
          <div className="tier-options" role="radiogroup">
            {TIERS.map((tier) => (
              <button
                key={tier}
                className={`tier-option${
                  profile.llm_provider === null && profile.llm_tier === tier
                    ? ' selected'
                    : ''
                }`}
                onClick={() =>
                  onSave({ llm_tier: tier, llm_provider: null, llm_model: null })
                }
              >
                {m.tierName(tier as Tier)}
              </button>
            ))}
          </div>
          {profile.llm_provider !== null && (
            <p className="pinned-note">
              {m.pinnedNote}
              <button
                className="icon-button"
                title={m.clearPin}
                onClick={() => onSave({ llm_provider: null, llm_model: null })}
              >
                ✕
              </button>
            </p>
          )}
          <details className="llm-advanced">
            <summary>{m.advanced}</summary>
            <div className="llm-advanced-body">
              <label>
                {m.llm}
                <select
                  value={profile.llm_provider ?? ''}
                  onChange={(e) =>
                    onSave({ llm_provider: e.target.value, llm_model: null })
                  }
                >
                  {profile.llm_provider === null && <option value="" />}
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label>
                {m.model}
                <select
                  value={profile.llm_model ?? activeProvider?.default_model ?? ''}
                  onChange={(e) => onSave({ llm_model: e.target.value })}
                >
                  {(activeProvider?.models.length
                    ? activeProvider.models
                    : [activeProvider?.default_model ?? '']
                  ).map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </div>
```

(The `activeProvider` line already exists in the card.) Note the empty `<option value="" />` shown while unpinned so the select is not lying about a selection.

3b. **`RulesView.tsx`** (Step 5b): its write-through `updateProfile` call omits `llm_tier`, which would null a stored tier on every rule toggle (the API passes the field through unconditionally). Add one line to the payload:

```typescript
        llm_tier: profile.llm_tier,
```

(after `llm_model: profile.llm_model,`; TypeScript enforces this once `Profile` carries the field — the build fails without it.)

4. Styles — append to `frontend/src/App.css`:

```css
.tier-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tier-option {
  font-size: 0.78rem;
  padding: 3px 8px;
  border: 1px solid #d8d8e0;
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
}

.tier-option.selected {
  background: #5b5bd6;
  border-color: #5b5bd6;
  color: #fff;
}

.pinned-note {
  font-size: 0.75rem;
  color: #667;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 0;
}
```

(In the ProfilesView cards the `.llm-advanced[open] .llm-advanced-body` popover style from Task 7 also applies; if the absolute positioning clashes inside cards, scope the popover rule to `.header-controls .llm-advanced[open] .llm-advanced-body` and give the card variant a static layout: `display: flex; gap: 8px; padding-top: 6px;`.)

- [ ] **Step 6: Verify**

Run: `cd frontend && npm test -- --run && npm run lint && npm run build` — all clean.
Manual smoke: ProfilesView cards show the four tier chips; the seeded Standard shows "Balanced" selected on a fresh DB (existing DBs show the pinned provider in Advanced with the pinned-note); clicking a chip on a pinned profile clears the pin; header dirty marker appears when the header tier differs from the profile's.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/profiles/profile.ts frontend/src/profiles/profile.test.ts frontend/src/state/store.ts frontend/src/header/ProfileSelector.tsx frontend/src/profiles/ProfilesView.tsx frontend/src/App.css
git commit -m "feat(profiles): tier-first profile editing with pinned-model escape hatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Documentation

**Files:**
- Modify: `backend/config.example.yaml`
- Modify: `docs/backend-architecture.md`
- Modify: `docs/frontend-architecture.md`
- Modify: `docs/model-recommendations.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-06-language-routed-models-design.md` (record the two deviations from the plan header)

- [ ] **Step 1: `backend/config.example.yaml`** — append at the end (top level, after the `nlp:` block):

```yaml
# Quality-tier routing: per language, which provider+model each tier
# (quality | balanced | cheap | local) resolves to. Defaults ship in code
# (from docs/model-recommendations.md); a language listed here replaces
# that language's whole tier map, unlisted languages keep the defaults.
# Tiers whose provider is not configured show as unavailable in the UI.
# routing:
#   default_tier: balanced
#   languages:
#     de:
#       quality:  { provider: claude,  model: claude-opus-4-8 }
#       balanced: { provider: mistral, model: mistral-large-latest }
#       cheap:    { provider: gemini,  model: models/gemini-flash-latest }
#       local:    { provider: ollama,  model: mistral-nemo:12b-instruct-2407-q6_K }
```

- [ ] **Step 2: `docs/backend-architecture.md`**

- Module map: add `│   │   ├── routing.py           # tier routing table + per-tier availability` under the `api/` entries (alphabetical position).
- Configuration section: append to the knobs sentence: `..., and the routing section ('routing.default_tier', per-language tier maps — validated tier/language names, per-language override of shipped defaults).`
- API surface table: add row `| GET /api/routing | tier routing table with per-tier availability + reason |`.
- Checking profiles section: document the `llm_tier` column and the precedence rule (pin > tier > no opinion; existing rows unaffected; fresh seeds tier=balanced).
- Note the availability-helper deviation: routing does cheap status checks (key present / Ollama ping / AWS creds) rather than sharing `/api/providers`' discovery-based logic.

- [ ] **Step 3: `docs/frontend-architecture.md`**

- Module map: add `│   ├── routing.ts             # resolveModel(): tier → provider/model, explicit failure` under `checking/`, and `│   ├── LlmSelector.tsx        # tier dropdown + resolved caption + advanced pin panel` under `header/`.
- State management: persisted slice now includes `tier` (with the v0→v1 migration note: pre-tier users stay pinned); `routing` table is ephemeral; `setProvider`/`setModel` pin (clear the tier).
- Checking lifecycle: `runCheck` resolves via `resolveModel` first; an unresolvable tier skips the LLM checker and surfaces `llmSkipped(reason)` in the status area — fast checkers still run.
- Profiles section: mode-aware `applyProfileToHeader`/`isProfileDirty` (pin > tier > no opinion), the save mapping (tier mode nulls the pin and vice versa), and the ProfilesView tier chips + Advanced panel.

- [ ] **Step 4: `docs/model-recommendations.md`** — § 5: change the heading from "Design sketch: language-routed configuration (not implemented)" to "Language-routed configuration (implemented 2026-07: provider registry + tier routing)"; replace the sketch YAML block with a short pointer: the shipped config format is documented in `backend/config.example.yaml` (`extra_providers` + `routing`), and the sketch's `local_models` presets and OpenRouter failover were deliberately not built (see the spec's decision table). Update the § 1 intro sentence to mention the tier selector. Keep the recommendation tables (§ 2-4) unchanged — they are the source the default routing table cites.

- [ ] **Step 5: `README.md`** — in the "LLM providers" section, add one paragraph after the table:

```markdown
In the header you normally pick a **quality tier** (Best quality / Balanced /
Fast & economical / Private (local)) — a per-language routing table
(`routing` in `config.yaml`, sensible defaults built in) resolves it to a
concrete provider and model, and unavailable tiers are shown greyed out with
the reason. The Advanced panel still lets you pin an exact provider+model;
checking profiles store either a tier or a pin.
```

- [ ] **Step 6: Spec deviations** — append to the spec's decision table (or a short "Implementation notes" section at the bottom of `2026-07-06-language-routed-models-design.md`): the availability-helper deviation and the English-reasons deviation, as worded in this plan's header.

- [ ] **Step 7: Verify and commit**

Run: `cd backend && uv run pytest tests/test_config.py -q` (sanity).

```bash
git add backend/config.example.yaml docs/backend-architecture.md docs/frontend-architecture.md docs/model-recommendations.md README.md docs/superpowers/specs/2026-07-06-language-routed-models-design.md
git commit -m "docs: document quality-tier routing (phase 2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end verification, logbook, push

**Files:**
- Modify: `docs/LOGBOOK.md`

- [ ] **Step 1: Full suites**

Run: `cd backend && uv run pytest` — PASS.
Run: `cd frontend && npm test -- --run && npm run lint && npm run build` — PASS/clean.

- [ ] **Step 2: Backend E2E** (TestClient against a temp DB; no keys needed):

```bash
cd backend && uv run python - << 'EOF'
import os, tempfile
from pathlib import Path
from app.core.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient

for key in list(os.environ):
    if key.endswith("_API_KEY"):
        del os.environ[key]
with tempfile.TemporaryDirectory() as tmp:
    settings = Settings(db_path=Path(tmp) / "e2e.db")
    client = TestClient(create_app(settings))
    routing = client.get("/api/routing").json()
    de = routing["languages"]["de"]
    assert de["balanced"]["provider"] == "mistral"
    assert de["balanced"]["available"] is False
    assert "MISTRAL_API_KEY" in de["balanced"]["reason"]
    std = [p for p in client.get("/api/profiles?language=de").json() if p["is_standard"]][0]
    assert std["llm_tier"] == "balanced" and std["llm_provider"] is None
    bad = client.post("/api/profiles", json={"language": "de", "name": "X", "llm_tier": "nope"})
    assert bad.status_code == 422
    print("routing + tier seeding + validation OK")
EOF
```

Expected output: `routing + tier seeding + validation OK`.

- [ ] **Step 3: Browser E2E** (dev servers running, real keys sourced): header shows tier dropdown; DE + Balanced resolves to mistral-large-latest and runs a check end-to-end; a tier whose key is missing is greyed out with the reason; pinning via Advanced marks the profile dirty; saving a tier-mode header into a profile stores `llm_tier` and clears the pin; existing profile (pinned) still applies as pinned.

- [ ] **Step 4: Logbook + push**

Append to `docs/LOGBOOK.md` (fill in the commit hashes):

```markdown
## <date> — Quality tiers with language routing (phase 2)

Commits: `<config>`, `<routing-api>`, `<profiles>`, `<store>`, `<resolution>`,
`<i18n>`, `<header>`, `<profiles-ui>`, `<docs>`

Implemented phase 2 of
`docs/superpowers/specs/2026-07-06-language-routed-models-design.md`: a
`routing` config section (code-shipped per-language defaults, per-language
override, fail-fast tier/language validation), `GET /api/routing` with
per-tier availability + reason, nullable `llm_tier` profile column
(pin > tier > no opinion; existing rows unchanged; fresh seeds
tier=balanced), client-side `resolveModel` (check API untouched), tier-first
header and ProfilesView with collapsed Advanced pin panels, no silent
degradation (unavailable tiers greyed out; LLM check skipped with reason),
i18n in all seven locales, persisted-store v1 migration keeping pre-tier
users pinned.
```

```bash
git add docs/LOGBOOK.md
git commit -m "docs: logbook entry for quality tiers (phase 2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

Watch CI for the pushed SHA: Backend CI, Frontend CI, and "Push on main" must all succeed.

- [ ] **Step 5 (optional, screenshots):** with both dev servers running, `cd frontend && npm run screenshots` to refresh the README images (the header changed). Commit separately if run.
