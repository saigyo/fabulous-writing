# Provider Registry (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Additional OpenAI-compatible LLM providers (DeepSeek, Qwen, OpenRouter, …) become first-class named entries defined in `config.yaml`, usable in the header dropdown and pinnable in profiles — no new provider code, no UI changes.

**Architecture:** Phase 1 of `docs/superpowers/specs/2026-07-06-language-routed-models-design.md`. A new `extra_providers` map on `ProviderSettings` (validated names, fail-fast on config load) feeds two existing choke points: `make_provider_factory` (constructs an `OpenAICompatProvider` per entry, API key from the env variable derived from the entry name) and `GET /api/providers` (appends one discovery entry per extra). The frontend needs zero changes — extras appear as ordinary provider entries.

**Tech Stack:** Python 3.12+/FastAPI/pydantic, pytest (asyncio_mode=auto), uv. Frontend untouched.

**Repo conventions:** Commits go directly on `main` (owner agreement) and are pushed at the end. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Run backend tests from `backend/` with `uv run pytest`.

---

### Task 1: `ExtraProviderSettings` config model with name validation

**Files:**
- Modify: `backend/app/core/config.py`
- Test: `backend/tests/test_config.py`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_config.py` (note the new `pytest`/`ValidationError` imports at the top of the file):

```python
import pytest
from pydantic import ValidationError
```

```python
def test_extra_providers_parsed_from_yaml(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
providers:
  extra_providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      default_model: deepseek-v4-pro
    openrouter:
      base_url: https://openrouter.ai/api/v1
      default_model: anthropic/claude-sonnet-5
      exclude_model_fragments: [embedding]
""",
        encoding="utf-8",
    )
    settings = load_settings(config)
    extras = settings.providers.extra_providers
    assert set(extras) == {"deepseek", "openrouter"}
    assert extras["deepseek"].base_url == "https://api.deepseek.com/v1"
    assert extras["deepseek"].default_model == "deepseek-v4-pro"
    assert extras["deepseek"].exclude_model_fragments == []
    assert extras["openrouter"].exclude_model_fragments == ["embedding"]


def test_extra_providers_default_empty() -> None:
    assert Settings().providers.extra_providers == {}


def test_extra_provider_name_collision_with_builtin_fails(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
providers:
  extra_providers:
    mistral:
      base_url: https://example.test/v1
      default_model: some-model
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="built-in"):
        load_settings(config)


def test_extra_provider_invalid_name_fails(tmp_path: Path) -> None:
    # Uppercase/hyphens are rejected: the name derives the env variable.
    config = tmp_path / "config.yaml"
    config.write_text(
        """
providers:
  extra_providers:
    Deep-Seek:
      base_url: https://example.test/v1
      default_model: some-model
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="name"):
        load_settings(config)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_config.py -v`
Expected: the four new tests FAIL (`extra_providers` attribute missing / no `ValidationError` raised); the two existing tests still PASS.

- [ ] **Step 3: Implement the config model**

In `backend/app/core/config.py`, add `re` to the imports and `field_validator` to the pydantic import:

```python
import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator
```

Above `ProviderSettings`, add:

```python
# The five providers with dedicated construction/auth logic. Extra provider
# names must not shadow them.
BUILTIN_PROVIDERS = ("ollama", "claude", "openai", "mistral", "bedrock")

# Extra provider names derive their env variable (<NAME>_API_KEY), so they
# must be safe identifiers.
_EXTRA_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


class ExtraProviderSettings(BaseModel):
    """An OpenAI-compatible provider defined in config (key: <NAME>_API_KEY)."""

    base_url: str
    default_model: str
    exclude_model_fragments: list[str] = Field(default_factory=list)
```

Inside `ProviderSettings`, add the field and validator:

```python
    extra_providers: dict[str, ExtraProviderSettings] = Field(default_factory=dict)

    @field_validator("extra_providers")
    @classmethod
    def _check_extra_names(
        cls, value: dict[str, ExtraProviderSettings]
    ) -> dict[str, ExtraProviderSettings]:
        for name in value:
            if not _EXTRA_NAME_RE.match(name):
                raise ValueError(
                    f"invalid extra provider name '{name}': must match"
                    " ^[a-z][a-z0-9_]*$ (the name derives the"
                    f" {name.upper()}_API_KEY environment variable)"
                )
            if name in BUILTIN_PROVIDERS:
                raise ValueError(
                    f"extra provider name '{name}' collides with a built-in provider"
                )
        return value
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_config.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/core/config.py backend/tests/test_config.py
git commit -m "feat(config): extra_providers map for OpenAI-compatible vendors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Provider factory builds extra providers

**Files:**
- Modify: `backend/app/main.py` (the `factory` closure in `make_provider_factory`, lines ~32-62)
- Test: `backend/tests/test_provider_factory.py` (new file)

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_provider_factory.py`:

```python
import pytest

from app.checkers.llm.openai_compat import OpenAICompatProvider
from app.core.config import ExtraProviderSettings, ProviderSettings, Settings
from app.main import make_provider_factory


@pytest.fixture
def settings() -> Settings:
    return Settings(
        providers=ProviderSettings(
            extra_providers={
                "deepseek": ExtraProviderSettings(
                    base_url="https://api.deepseek.com/v1",
                    default_model="deepseek-v4-pro",
                    exclude_model_fragments=["embedding"],
                )
            }
        )
    )


def test_factory_builds_extra_provider(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    provider = make_provider_factory(settings)("deepseek")
    assert isinstance(provider, OpenAICompatProvider)
    assert provider.name == "deepseek"
    assert provider.base_url == "https://api.deepseek.com/v1"
    assert provider.model == "deepseek-v4-pro"
    assert provider.api_key == "sk-test"
    assert provider.exclude_models == ("embedding",)


def test_factory_extra_provider_model_override(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    provider = make_provider_factory(settings)("deepseek", "deepseek-v4-flash")
    assert provider.model == "deepseek-v4-flash"


def test_factory_extra_provider_without_key(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Construction succeeds; the missing key fails at request time with a
    # clear message (OpenAICompatProvider._client), same as openai/mistral.
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    provider = make_provider_factory(settings)("deepseek")
    assert provider.api_key is None


def test_factory_unknown_provider_still_raises(settings: Settings) -> None:
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        make_provider_factory(settings)("nonexistent")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_provider_factory.py -v`
Expected: the three extra-provider tests FAIL with `ValueError: Unknown LLM provider: deepseek`; `test_factory_unknown_provider_still_raises` already PASSES.

- [ ] **Step 3: Implement the factory branch**

In `backend/app/main.py`, inside the `factory` closure, insert between the `bedrock` branch and the final `raise`:

```python
        extra = providers.extra_providers.get(chosen)
        if extra is not None:
            return OpenAICompatProvider(
                name=chosen,
                base_url=extra.base_url,
                api_key=os.environ.get(f"{chosen.upper()}_API_KEY"),
                model=model or extra.default_model,
                exclude_models=tuple(extra.exclude_model_fragments),
            )
        raise ValueError(f"Unknown LLM provider: {chosen}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_provider_factory.py -v`
Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_provider_factory.py
git commit -m "feat(llm): provider factory constructs config-defined extra providers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `GET /api/providers` lists extras with availability + discovery

**Files:**
- Modify: `backend/app/api/providers.py` (`_openai_compat_entry`, `list_providers`)
- Test: `backend/tests/test_providers_api.py`

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_providers_api.py`:

1. Extend the `client` fixture — add `DEEPSEEK_API_KEY` to the env cleanup loop and an extra provider (unreachable URL, like the other entries) to the settings:

```python
@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    for key in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "MISTRAL_API_KEY",
        "DEEPSEEK_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(bedrock, "credentials_available", lambda: False)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        providers=ProviderSettings(
            ollama_base_url="http://127.0.0.1:9",
            openai_base_url="http://127.0.0.1:9/v1",
            mistral_base_url="http://127.0.0.1:9/v1",
            extra_providers={
                "deepseek": ExtraProviderSettings(
                    base_url="http://127.0.0.1:9/v1",
                    default_model="deepseek-v4-pro",
                )
            },
        ),
    )
    return TestClient(create_app(settings))
```

with the import updated to:

```python
from app.core.config import ExtraProviderSettings, ProviderSettings, Settings
```

2. Update the set assertion in `test_lists_all_providers_with_availability`:

```python
    assert set(providers) == {
        "ollama",
        "claude",
        "openai",
        "mistral",
        "bedrock",
        "deepseek",
    }
```

3. Add two tests at the end of the file:

```python
def test_extra_provider_unavailable_without_key(client: TestClient) -> None:
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    assert providers["deepseek"]["available"] is False
    assert providers["deepseek"]["default_model"] == "deepseek-v4-pro"


def test_extra_provider_available_with_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    # Key present but model listing unreachable: available, fallback models.
    assert providers["deepseek"]["available"] is True
    assert providers["deepseek"]["models"] == ["deepseek-v4-pro"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_providers_api.py -v`
Expected: `test_lists_all_providers_with_availability` and the two new tests FAIL (no `deepseek` entry); the others PASS.

- [ ] **Step 3: Implement discovery for extras**

In `backend/app/api/providers.py`:

1. Give `_openai_compat_entry` an explicit exclude parameter (replacing the `name == "openai"` special case):

```python
async def _openai_compat_entry(
    name: str,
    env_key: str,
    base_url: str,
    default_model: str,
    exclude_models: tuple[str, ...] = (),
) -> dict[str, Any]:
    api_key = os.environ.get(env_key)
    if not api_key:
        return _entry(name, False, [default_model], default_model)
    provider = OpenAICompatProvider(
        name=name,
        base_url=base_url,
        api_key=api_key,
        model=default_model,
        exclude_models=exclude_models,
    )
    try:
        async with asyncio.timeout(_DISCOVERY_TIMEOUT):
            models = await provider.list_models()
    except Exception:
        # Key is set but discovery failed — still usable with the default.
        models = [default_model]
    return _entry(name, True, models, default_model)
```

2. Rewrite `list_providers` to append one entry per extra:

```python
@router.get("/providers")
async def list_providers(request: Request) -> list[dict[str, Any]]:
    settings = request.app.state.settings.providers
    entries = [
        _ollama_entry(settings),
        _claude_entry(settings),
        _openai_compat_entry(
            "openai",
            "OPENAI_API_KEY",
            settings.openai_base_url,
            settings.openai_model,
            OPENAI_EXCLUDED_MODEL_FRAGMENTS,
        ),
        _openai_compat_entry(
            "mistral",
            "MISTRAL_API_KEY",
            settings.mistral_base_url,
            settings.mistral_model,
        ),
        _bedrock_entry(settings),
    ]
    entries += [
        _openai_compat_entry(
            name,
            f"{name.upper()}_API_KEY",
            extra.base_url,
            extra.default_model,
            tuple(extra.exclude_model_fragments),
        )
        for name, extra in settings.extra_providers.items()
    ]
    return list(await asyncio.gather(*entries))
```

- [ ] **Step 4: Run the tests, then the full backend suite**

Run: `cd backend && uv run pytest tests/test_providers_api.py -v`
Expected: all PASS.

Run: `cd backend && uv run pytest`
Expected: full suite PASS (guards against regressions in check/suggestions APIs that go through the factory).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/providers.py backend/tests/test_providers_api.py
git commit -m "feat(api): /api/providers lists config-defined extra providers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Document the feature (config example, architecture docs, README, recommendations doc)

**Files:**
- Modify: `backend/config.example.yaml`
- Modify: `docs/backend-architecture.md` (Configuration section ~line 118, Providers section ~line 249)
- Modify: `README.md` (LLM providers section ~line 130, Configuration highlights ~line 154)
- Modify: `docs/model-recommendations.md` (§ 1, ~lines 34-50)

- [ ] **Step 1: Extend `backend/config.example.yaml`**

Append inside the `providers:` block (after `default_provider: ollama`):

```yaml
  # Additional OpenAI-compatible providers become first-class entries in the
  # header and profiles. The entry name derives the API-key env variable
  # (deepseek -> DEEPSEEK_API_KEY); keys are never stored in this file.
  # Names: lowercase [a-z0-9_], must not shadow the built-in five.
  # extra_providers:
  #   deepseek:
  #     base_url: https://api.deepseek.com/v1
  #     default_model: deepseek-v4-pro
  #   qwen:
  #     base_url: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
  #     default_model: qwen3.7-max
  #   openrouter:
  #     base_url: https://openrouter.ai/api/v1
  #     default_model: anthropic/claude-sonnet-5
  #     exclude_model_fragments: [embedding]   # optional /models filter
```

Also update the key comment block at the top of the file (lines 2-6) to:

```yaml
# Copy to config.yaml to override defaults. All keys are optional.
# API keys are read from the environment only, never from this file:
#   claude  -> ANTHROPIC_API_KEY
#   openai  -> OPENAI_API_KEY
#   mistral -> MISTRAL_API_KEY
#   bedrock -> standard AWS credential chain (env vars, profile, role)
#   extra_providers entries -> <NAME>_API_KEY (deepseek -> DEEPSEEK_API_KEY)
```

- [ ] **Step 2: Update `docs/backend-architecture.md`**

In the paragraph after the `app.state` table (~line 108), replace the sentence about API keys:

```markdown
The **provider factory** is the only place that knows how to construct concrete LLM
providers; everything else works against the `LLMProvider` protocol. Besides the five
built-ins, `extra_providers` entries from config (OpenAI-compatible endpoints such as
DeepSeek, Qwen, or OpenRouter) are constructed generically. API keys are read from the
environment at construction time (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`MISTRAL_API_KEY`, `<NAME>_API_KEY` for extras; Bedrock uses the standard AWS
credential chain) — they are never stored in config or the database.
```

In the Configuration section (~line 122), extend the knobs sentence:

```markdown
knobs: `db_path`, `rules_dir`, `seed_terminology`, `seed_example_profiles`,
`vet_suggestions`, `dictionaries_dir`, per-provider base URLs and default models,
`providers.extra_providers` (named OpenAI-compatible endpoints — validated at load:
lowercase identifier names that don't shadow built-ins, since the name derives the
`<NAME>_API_KEY` env variable), and the per-language spaCy model map (`nlp.models`).
```

In the Providers table (~line 256), add a row before `fake`:

```markdown
| config-defined extras (e.g. `deepseek`) | `openai_compat.py` via `extra_providers` config | `<NAME>_API_KEY` |
```

And extend the discovery paragraph (~line 264): change "OpenAI and Mistral `/models`" to "OpenAI, Mistral, and extras `/models`".

- [ ] **Step 3: Update `README.md`**

Add a row to the LLM providers table (after the `bedrock` row, ~line 141):

```markdown
| config-defined extras | any OpenAI-compatible vendor (DeepSeek, Qwen, Gemini, OpenRouter, …) via `providers.extra_providers` in `config.yaml`; key from `<NAME>_API_KEY` |
```

Replace the paragraph at ~lines 143-147 with:

```markdown
Which model to pick — per language, API vs. local Ollama, hardware and cost
considerations — is covered in
[docs/model-recommendations.md](docs/model-recommendations.md).
```

Extend the Configuration highlight bullet (~line 154):

```markdown
- `providers.*` — default LLM provider, per-provider models/endpoints, extra
  OpenAI-compatible providers (`extra_providers`), Bedrock region and pinned model ids
```

- [ ] **Step 4: Update `docs/model-recommendations.md` § 1**

Replace the paragraph starting "**Using providers not built in**" (lines 34-50, up to and including the sentence about the two slots) with:

```markdown
**Using providers not built in (DeepSeek, Qwen, Gemini, OpenRouter):** all of
them speak the OpenAI chat-completions protocol and can be added as named
entries under `providers.extra_providers` in `backend/config.yaml`, e.g.:

```yaml
providers:
  extra_providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      default_model: deepseek-v4-pro
```

with the key in the environment variable derived from the entry name
(`DEEPSEEK_API_KEY`). The entry appears in the header dropdown with live model
discovery, and profiles can pin it. The same works for Qwen/DashScope
(`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`), Google
(`https://generativelanguage.googleapis.com/v1beta/openai`), and OpenRouter
(`https://openrouter.ai/api/v1`). Tiered per-language routing on top of these
entries is the design sketch in section 5.
```

- [ ] **Step 5: Verify and commit**

Run: `cd backend && uv run pytest tests/test_config.py -v` (docs-only change — quick sanity that nothing broke by accident).
Expected: PASS.

```bash
git add backend/config.example.yaml docs/backend-architecture.md README.md docs/model-recommendations.md
git commit -m "docs: document extra_providers registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end verification, logbook, push

**Files:**
- Modify: `docs/LOGBOOK.md`

- [ ] **Step 1: Verify against the running app**

Start the backend with a temp config that defines an extra provider (no key set):

```bash
cd backend
cat > /tmp/fw-e2e-config.yaml << 'EOF'
providers:
  extra_providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      default_model: deepseek-v4-pro
EOF
FW_CONFIG=/tmp/fw-e2e-config.yaml uv run python - << 'EOF'
import os
from pathlib import Path
from app.core.config import load_settings
from app.main import create_app
from fastapi.testclient import TestClient

settings = load_settings(Path(os.environ["FW_CONFIG"]))
client = TestClient(create_app(settings))
entries = {e["name"]: e for e in client.get("/api/providers").json()}
assert "deepseek" in entries, entries.keys()
print("deepseek entry:", entries["deepseek"])
EOF
```

Expected output: `deepseek entry: {'name': 'deepseek', 'available': False, 'models': ['deepseek-v4-pro'], 'default_model': 'deepseek-v4-pro'}`.

If a real `DEEPSEEK_API_KEY` (or Ollama-as-extra, `base_url: http://localhost:11434/v1`) is available, additionally verify in the browser: start backend + frontend dev servers, confirm the extra appears in the header LLM dropdown and a check runs through it. Otherwise the availability=False path above suffices — the frontend renders entries generically.

- [ ] **Step 2: Full suite + logbook entry**

Run: `cd backend && uv run pytest`
Expected: PASS.

Append to `docs/LOGBOOK.md` (fill in the actual commit hashes):

```markdown
## <date> — Provider registry (phase 1 of language-routed models)

Commits: `<config>`, `<factory>`, `<api>`, `<docs>`

Implemented phase 1 of
`docs/superpowers/specs/2026-07-06-language-routed-models-design.md`:
`providers.extra_providers` in `config.yaml` defines additional
OpenAI-compatible providers (DeepSeek, Qwen, OpenRouter, …) as first-class
named entries — validated names (env key `<NAME>_API_KEY` derived from the
entry name, no collisions with built-ins, fail-fast on load), constructed
generically by the provider factory, listed by `GET /api/providers` with
live model discovery. Zero frontend changes. Docs + config example updated.
```

- [ ] **Step 3: Commit and push**

```bash
git add docs/LOGBOOK.md
git commit -m "docs: logbook entry for provider registry (phase 1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

Watch CI for the pushed SHA (`gh run list --json headSha,name,status,conclusion`): Backend CI and "Push on main" must both succeed.
