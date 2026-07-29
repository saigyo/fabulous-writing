# LLM Ledger Telemetry (B5 + B7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify failed LLM runs (`fail_stage`/`fail_detail` on `llm_usage`) and settle real provider-reported token counts into the ledger, per `docs/superpowers/specs/2026-07-29-llm-ledger-telemetry-design.md` (closes #38 and #39).

**Architecture:** `LLMProvider.generate` changes its return type from `str` to `GenerationResult(text, usage: TokenUsage)` across all five implementations; a central `classify_failure(exc)` helper in `app/api/llm_gate.py` maps exceptions to the owner-decided stage enum; `UsageStore.finish_run` gains failed-path-only `fail_stage`/`fail_detail` columns; the three LLM-invoking paths (checks, suggestions, naming) settle usage and classification at their existing `finish` calls. The checks-path hole where unparseable output settled `'completed'` closes via a new `UnparseableResponseError`.

**Tech Stack:** Python 3.13, FastAPI, SQLite (stdlib `sqlite3`), httpx, pytest. All backend commands run from `backend/` via `uv run`.

## Global Constraints

- The live database `backend/data/fabulous.db` is never read or written by tests; `create_app()` is never called with default settings in tests — every test passes `tmp_path`-based `Settings`.
- No new Settings/config/env knobs anywhere in this work.
- Secrets from environment only; never in repo, DB, or logs.
- `fail_detail` stores error **metadata** only (exception class, HTTP status, first 200 whitespace-collapsed chars) — never document text or raw provider response bodies.
- `fail_stage`/`fail_detail` are written **only** when `status == 'failed'`; the store nulls them for any other status regardless of what the caller passes.
- `fail_stage` enum, exact values: `'request'`, `'provider'`, `'response'`.
- `TokenUsage` fields are `int | None`; `None` means "not reported", never 0. Missing telemetry is never an error.
- Never kill, restart, or start anything on ports 5173 and 8000.
- Never widen a wall-clock test bound.
- Gate before every commit: `uv run pytest -q` from `backend/` with zero warnings.
- Mutation-verify every guard test: delete the guard, watch the test fail, restore.
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

## File Map

| File | Role in this plan |
|---|---|
| `backend/app/services/usage.py` | Task 1: schema columns, migration, `finish_run` failed-path guard |
| `backend/app/api/llm_gate.py` | Task 1: `LlmReservation.finish` forwarding · Task 5: `classify_failure` |
| `backend/app/checkers/llm/provider.py` | Task 2: `TokenUsage`, `GenerationResult`, `MissingApiKeyError`, protocol, `FakeProvider` |
| `backend/app/checkers/llm/_http_chat.py` | Task 2: wrap return · Task 3: usage stream event + `_response_usage` hook |
| `backend/app/checkers/llm/ollama.py` | Task 3: usage extraction |
| `backend/app/checkers/llm/openai_compat.py` | Task 2: `MissingApiKeyError` · Task 3: usage + `stream_options` |
| `backend/app/checkers/llm/claude.py` | Task 2: wrap return · Task 4: usage extraction |
| `backend/app/checkers/llm/bedrock.py` | Task 2: wrap return · Task 4: usage extraction |
| `backend/app/checkers/llm/checker.py` | Task 2: `.text` · Task 5: `UnparseableResponseError` · Task 6: `LLMCheckResult.usage` |
| `backend/app/api/checks.py` | Task 2: (via checker) · Task 6: settle usage + classification in `_run_llm` |
| `backend/app/api/suggestions.py` | Task 2: `.text` · Task 6: settle usage + classification |
| `backend/app/api/documents.py` | Task 2: `.text` · Task 6: settle usage + classification |
| `backend/tests/test_usage.py` | Task 1 tests |
| `backend/tests/test_providers.py`, `test_openai_compat.py`, `test_bedrock.py` | Tasks 2–4 test updates |
| `backend/tests/test_llm_checker.py` | Task 5: unparseable-raises flip |
| `backend/tests/test_failure_classification.py` | Task 5: classifier unit tests (new file) |
| `backend/tests/test_check_api.py`, `test_suggestions_api.py`, `test_documents_api.py` | Task 2: test doubles · Task 6: endpoint ledger tests |
| `docs/backend-architecture.md` | Task 6: ledger + provider-protocol sections |

---

### Task 1: Ledger columns and the failed-path-only write guard

**Files:**
- Modify: `backend/app/services/usage.py` (`_SCHEMA`, `__init__`, `finish_run`)
- Modify: `backend/app/api/llm_gate.py:37-40` (`LlmReservation.finish`)
- Test: `backend/tests/test_usage.py`

**Interfaces:**
- Consumes: `migrate_columns(conn, table, columns)` from `app/services/_sqlite.py` (exists).
- Produces: `UsageStore.finish_run(reservation_id, status, *, input_tokens=None, output_tokens=None, fail_stage=None, fail_detail=None)` and `LlmReservation.finish(status, *, input_tokens=None, output_tokens=None, fail_stage=None, fail_detail=None)` — Task 6 relies on both signatures exactly.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_usage.py`:

```python
class TestFailureColumns:
    def test_failed_run_records_stage_and_detail(self, store):
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id,
            "failed",
            fail_stage="provider",
            fail_detail="HTTPStatusError (503): upstream unavailable",
        )
        (row,) = rows(store)
        assert row["status"] == "failed"
        assert row["fail_stage"] == "provider"
        assert row["fail_detail"] == "HTTPStatusError (503): upstream unavailable"

    @pytest.mark.parametrize("status", ["completed", "cancelled"])
    def test_non_failed_status_nulls_stage_and_detail(self, store, status):
        # Guard (spec §4.2): NULL by construction, not caller discipline —
        # a caller passing classification alongside a success must not
        # smuggle it into the row.
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id,
            status,
            fail_stage="provider",
            fail_detail="should be discarded",
        )
        (row,) = rows(store)
        assert row["status"] == status
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None

    def test_finish_run_rejects_unknown_stage_in_code(self, store):
        # Migrated databases have no CHECK constraint on fail_stage; the
        # store itself must refuse a typo'd stage on every database.
        decision = reserve(store)
        with pytest.raises(ValueError, match="unknown fail_stage"):
            store.finish_run(
                decision.reservation_id, "failed",
                fail_stage="parse", fail_detail="typo'd stage",
            )
        (row,) = rows(store)
        assert row["status"] == "started"  # the write never happened

    def test_check_constraint_rejects_unknown_stage(self, store):
        with connect(store.db_path) as conn:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    """INSERT INTO llm_usage (user_id, day, created_at, status,
                       provider, model, text_chars, source, run_id, fail_stage)
                       VALUES (1, '2026-07-29', '2026-07-29T00:00:00+00:00',
                               'failed', 'p', 'm', 1, 'check', 'r', 'parse')"""
                )

    def test_migration_adds_columns_to_pre_b5_database(self, tmp_path):
        # A database created before this change lacks both columns; opening
        # it through UsageStore must add them and leave old rows NULL.
        db_path = tmp_path / "old.db"
        with connect(db_path) as conn:
            conn.executescript(_PRE_B5_SCHEMA)
            conn.execute(
                """INSERT INTO llm_usage (user_id, day, created_at, status,
                   provider, model, text_chars, source, run_id)
                   VALUES (1, '2026-07-20', '2026-07-20T00:00:00+00:00',
                           'failed', 'p', 'm', 1, 'check', 'r')"""
            )
        store = UsageStore(db_path)
        (row,) = rows(store)
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None
        # And the migrated store accepts classified writes.
        decision = reserve(store, run_id="r2")
        store.finish_run(
            decision.reservation_id, "failed",
            fail_stage="request", fail_detail="ConnectError: refused",
        )
        assert rows(store)[-1]["fail_stage"] == "request"


_PRE_B5_SCHEMA = """
CREATE TABLE IF NOT EXISTS llm_usage (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL,
    day                TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    status             TEXT NOT NULL,
    llm_tier           TEXT,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    requested_tier     TEXT,
    requested_provider TEXT,
    requested_model    TEXT,
    text_chars         INTEGER NOT NULL,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    source             TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    CHECK (status IN ('started','completed','failed','cancelled','abandoned'))
);
"""
```

Place `_PRE_B5_SCHEMA` at module level (bottom of the file is fine; shown here after the class for reading order).

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_usage.py::TestFailureColumns -v`
Expected: FAIL — `finish_run() got an unexpected keyword argument 'fail_stage'` / no such column `fail_stage`.

- [ ] **Step 3: Implement**

In `backend/app/services/usage.py`:

1. Import: `from app.services._sqlite import connect, migrate_columns`
2. In `_SCHEMA`, extend the `llm_usage` table definition — add two column lines after `run_id` and one table constraint after the existing status CHECK:

```sql
    run_id             TEXT NOT NULL,
    fail_stage         TEXT,
    fail_detail        TEXT,
    -- Not decoration: a typo'd terminal status would silently leak a
    -- concurrency slot for llm_run_max_age (spec §5.3).
    CHECK (status IN ('started','completed','failed','cancelled','abandoned')),
    -- Enum guard for fresh databases only; migrated tables rely on the
    -- code-level guarantee (SQLite cannot add a CHECK without a rebuild,
    -- and a bad fail_stage cannot leak a concurrency slot).
    CHECK (fail_stage IN ('request','provider','response') OR fail_stage IS NULL)
```

2b. Add a module-level constant next to `RETRY_AFTER_SECONDS`:

```python
# The single source for the fresh-schema CHECK and finish_run's code-level
# enforcement (migrated databases have no CHECK).
_FAIL_STAGES = ("request", "provider", "response")
```

3. In `__init__`, after `conn.executescript(_SCHEMA)`:

```python
            migrate_columns(
                conn,
                "llm_usage",
                [("fail_stage", "TEXT"), ("fail_detail", "TEXT")],
            )
```

4. Replace `finish_run` with:

```python
    def finish_run(
        self,
        reservation_id: int,
        status: str,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        fail_stage: str | None = None,
        fail_detail: str | None = None,
    ) -> None:
        """Terminal write — conditional on the row still being 'started'
        (spec §6.6): a swept row's slot is already gone, so it is warned
        about, never resurrected. Callers run this in a finally block.

        fail_stage/fail_detail land only with status='failed' — nulled here
        by construction, not by caller discipline. The stage enum is
        enforced here in code, not only by the fresh-schema CHECK: migrated
        databases have no CHECK, and a typo'd stage must fail loudly on
        them too."""
        if status != "failed":
            fail_stage = None
            fail_detail = None
        if fail_stage is not None and fail_stage not in _FAIL_STAGES:
            raise ValueError(f"unknown fail_stage: {fail_stage!r}")
        with connect(self.db_path, timeout=self.timeout) as conn:
            cursor = conn.execute(
                """UPDATE llm_usage
                   SET status = ?, input_tokens = ?, output_tokens = ?,
                       fail_stage = ?, fail_detail = ?
                   WHERE id = ? AND status = 'started'""",
                (status, input_tokens, output_tokens,
                 fail_stage, fail_detail, reservation_id),
            )
            if cursor.rowcount == 0:
                logger.warning(
                    "llm_usage row %s was already swept; terminal status %r"
                    " discarded",
                    reservation_id,
                    status,
                )
```

In `backend/app/api/llm_gate.py`, replace `LlmReservation.finish`:

```python
    def finish(
        self,
        status: str,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        fail_stage: str | None = None,
        fail_detail: str | None = None,
    ) -> None:
        self.store.finish_run(
            self.reservation_id,
            status,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            fail_stage=fail_stage,
            fail_detail=fail_detail,
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_usage.py -v`
Expected: all PASS.

- [ ] **Step 5: Mutation-verify both guards**

1. Temporarily delete the `if status != "failed":` block in `finish_run`, run `uv run pytest tests/test_usage.py::TestFailureColumns::test_non_failed_status_nulls_stage_and_detail -v`, confirm it FAILS, restore, confirm green.
2. Temporarily delete the `CHECK (fail_stage IN ...)` line from `_SCHEMA`, run `uv run pytest tests/test_usage.py::TestFailureColumns::test_check_constraint_rejects_unknown_stage -v`, confirm it FAILS, restore, confirm green.
3. Temporarily delete the `raise ValueError` guard in `finish_run`, run `uv run pytest tests/test_usage.py::TestFailureColumns::test_finish_run_rejects_unknown_stage_in_code -v`, confirm it FAILS, restore, confirm green.

- [ ] **Step 6: Full-suite gate and commit**

Run: `uv run pytest -q` — zero failures, zero warnings.

```bash
git add backend/app/services/usage.py backend/app/api/llm_gate.py backend/tests/test_usage.py
git commit -m "$(cat <<'EOF'
feat(ledger): fail_stage/fail_detail columns, written only on the failed path (B5, #38)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 2: `GenerationResult` protocol sweep (no real usage yet)

Every implementation wraps its text in `GenerationResult` with empty usage; real extraction follows in Tasks 3–4. This keeps each task green and reviewable.

**Files:**
- Modify: `backend/app/checkers/llm/provider.py` (full rewrite below)
- Modify: `backend/app/checkers/llm/_http_chat.py:48-78`
- Modify: `backend/app/checkers/llm/claude.py:26-58`
- Modify: `backend/app/checkers/llm/bedrock.py:76-104`
- Modify: `backend/app/checkers/llm/openai_compat.py:34-39`
- Modify: `backend/app/checkers/llm/checker.py:117`
- Modify: `backend/app/api/suggestions.py:109`
- Modify: `backend/app/api/documents.py:257`
- Test: `backend/tests/test_providers.py`, `backend/tests/test_openai_compat.py`, `backend/tests/test_bedrock.py`, `backend/tests/test_check_api.py:194-204`, `backend/tests/test_documents_api.py:159-174`

**Interfaces:**
- Produces (Tasks 3–6 rely on these exactly):
  - `TokenUsage(input_tokens: int | None = None, output_tokens: int | None = None)` — frozen dataclass, `app/checkers/llm/provider.py`
  - `GenerationResult(text: str, usage: TokenUsage)` — frozen dataclass, same module
  - `MissingApiKeyError(RuntimeError)` — same module
  - `LLMProvider.generate(...) -> GenerationResult`
  - `FakeProvider(response, progress_steps=None, usage=None)` — `usage` defaults to `TokenUsage()`

- [ ] **Step 1: Update the provider contract tests first**

In `backend/tests/test_providers.py`, `backend/tests/test_openai_compat.py`, `backend/tests/test_bedrock.py`, change every direct assertion on `generate`'s return value to go through `.text`:

- `test_providers.py:27` → `assert result.text == "[]"`
- `test_providers.py:102` → `assert result.text == "[]"`
- `test_providers.py:130` → `assert result.text == '["a"]'`
- `test_providers.py:175` → `assert result.text == "[]"`
- `test_openai_compat.py:37` → `assert result.text == "[]"`
- `test_openai_compat.py:82` → `assert result.text == "[]"`
- `test_bedrock.py:32` → `assert result.text == "[]"`
- `test_bedrock.py:56` → `assert result.text == "[]"`

The missing-API-key test (`test_openai_compat.py:47-55`) stays as-is: `MissingApiKeyError` subclasses `RuntimeError`, so `pytest.raises(RuntimeError, match="MISTRAL_API_KEY")` still passes.

Also add to `TestClaudeProvider` in `test_providers.py` (Claude constructs `AsyncAnthropic()` lazily; without this guard a missing `ANTHROPIC_API_KEY` surfaces as an SDK constructor error that classification would file as `'provider'` instead of `'request'`):

```python
    async def test_missing_api_key_raises_clear_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        provider = ClaudeProvider(model="claude-sonnet-5")
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
            await provider.generate("s", "u")
```

(Add `import pytest` to `test_providers.py` if not present.)

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_providers.py tests/test_openai_compat.py tests/test_bedrock.py -v`
Expected: FAIL — `AttributeError: 'str' object has no attribute 'text'`.

- [ ] **Step 3: Rewrite `provider.py`**

Full new content of `backend/app/checkers/llm/provider.py`:

```python
from dataclasses import dataclass
from typing import Callable, Protocol

# Called with the cumulative number of generated output tokens (approximate
# for providers that only expose chunk counts).
ProgressCallback = Callable[[int], None]


@dataclass(frozen=True)
class TokenUsage:
    """Exact counts reported by the provider API. None means "not reported"
    — never 0, which is a real reported value."""

    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class GenerationResult:
    text: str
    usage: TokenUsage


class MissingApiKeyError(RuntimeError):
    """No API key configured for a provider. Its own type so failure
    classification can file it as a 'request'-stage error without matching
    on message text."""


class LLMProvider(Protocol):
    """A pluggable LLM backend for the checking pipeline."""

    name: str

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        """Return the raw model response plus reported token usage.

        When `on_progress` is given, providers stream the response and report
        cumulative output tokens as they arrive. A provider that cannot find
        usage in a response returns TokenUsage(None, None) — missing
        telemetry is never an error.
        """
        ...


class FakeProvider:
    """Canned-response provider for tests and offline development."""

    name = "fake"

    def __init__(
        self,
        response: str,
        progress_steps: list[int] | None = None,
        usage: TokenUsage | None = None,
    ) -> None:
        self.response = response
        self.progress_steps = progress_steps or []
        # `is not None`, not `or`: None means "not configured" everywhere in
        # this module and must not be conflated with falsiness.
        self.usage = usage if usage is not None else TokenUsage()
        self.calls: list[tuple[str, str]] = []

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        self.calls.append((system, user))
        if on_progress is not None:
            for step in self.progress_steps:
                on_progress(step)
        return GenerationResult(text=self.response, usage=self.usage)
```

- [ ] **Step 4: Wrap the four real implementations**

`backend/app/checkers/llm/_http_chat.py` — import `GenerationResult, TokenUsage` from `.provider`; change the two return paths:

```python
    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        payload = self._payload(system, user, stream=on_progress is not None)
        if on_progress is not None:
            return await self._generate_streaming(payload, on_progress)
        async with self._client() as client:
            response = await client.post(self._chat_path, json=payload)
            response.raise_for_status()
            return GenerationResult(
                text=self._response_text(response.json()), usage=TokenUsage()
            )

    async def _generate_streaming(
        self, payload: dict, on_progress: ProgressCallback
    ) -> GenerationResult:
        parts: list[str] = []
        async with self._client() as client:
            async with client.stream("POST", self._chat_path, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    done = False
                    for kind, value in self._stream_events(line):
                        if kind == "content":
                            parts.append(str(value))
                            on_progress(len(parts))
                        elif kind == "tokens":
                            on_progress(int(value))
                        elif kind == "done":
                            done = True
                    if done:
                        break
        return GenerationResult(text="".join(parts), usage=TokenUsage())
```

`backend/app/checkers/llm/claude.py` — import `GenerationResult, MissingApiKeyError, TokenUsage` from `.provider`. Guard the lazy client construction (mirroring OpenAI-compat, so a missing key classifies as `'request'`):

```python
    def _get_client(self) -> Any:
        if self._client is None:
            import os

            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise MissingApiKeyError(
                    "No API key for provider 'claude' — "
                    "set the ANTHROPIC_API_KEY environment variable."
                )
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic()
        return self._client
```

and wrap both generate paths:

```python
    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        kwargs: dict[str, Any] = dict(
            model=self.model,
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        if on_progress is not None:
            return await self._generate_streaming(kwargs, on_progress)
        response = await self._get_client().messages.create(**kwargs)
        text = "".join(
            block.text for block in response.content if block.type == "text"
        )
        return GenerationResult(text=text, usage=TokenUsage())
```

and `_generate_streaming` returns `GenerationResult(text="".join(parts), usage=TokenUsage())` (signature `-> GenerationResult`).

`backend/app/checkers/llm/bedrock.py` — import `GenerationResult, TokenUsage` from `.provider`:

```python
    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        kwargs = self._converse_kwargs(system, user)
        if on_progress is not None:
            loop = asyncio.get_running_loop()

            def report(tokens: int) -> None:
                loop.call_soon_threadsafe(on_progress, tokens)

            return await asyncio.to_thread(self._stream_sync, kwargs, report)
        response = await asyncio.to_thread(lambda: self._get_client().converse(**kwargs))
        blocks = response["output"]["message"]["content"]
        text = "".join(block.get("text", "") for block in blocks)
        return GenerationResult(text=text, usage=TokenUsage())
```

and `_stream_sync` gets signature `-> GenerationResult`, ending with `return GenerationResult(text="".join(parts), usage=TokenUsage())`.

`backend/app/checkers/llm/openai_compat.py` — import `MissingApiKeyError` from `.provider`; in `_client()` replace `RuntimeError` with `MissingApiKeyError` (message unchanged).

- [ ] **Step 5: Adapt the three call sites to `.text`**

- `backend/app/checkers/llm/checker.py:117`:
  ```python
        response = (await self.provider.generate(system, user, on_progress)).text
  ```
- `backend/app/api/suggestions.py:109`:
  ```python
        response = (await provider.generate(system, prompt)).text
  ```
- `backend/app/api/documents.py:257`:
  ```python
                    title = clean_title((await provider.generate(system, prompt)).text)
  ```

(Task 6 rewrites all three to keep the full result; this step only keeps the suite green.)

- [ ] **Step 6: Update the string-returning test doubles**

`backend/tests/test_check_api.py:194-204` — `RecordingProvider.generate` returns `GenerationResult(text="[]", usage=TokenUsage())`; add `from app.checkers.llm.provider import GenerationResult, TokenUsage` to the file's imports (extend the existing `provider` import line if present).

`backend/tests/test_documents_api.py:159-174` — `RenamingProvider.generate` ends with `return GenerationResult(text=self.response, usage=TokenUsage())`; same import addition.

`BrokenProvider`/`HangingProvider` variants raise or hang and never return — leave them.

- [ ] **Step 7: Run the full suite**

Run: `uv run pytest -q`
Expected: all PASS, zero warnings. (test_llm_checker, test_check_api, test_suggestions_api, test_documents_api all exercise `FakeProvider` through the adapted call sites.)

- [ ] **Step 8: Commit**

```bash
git add backend/app/checkers/llm/ backend/app/api/suggestions.py backend/app/api/documents.py backend/tests/
git commit -m "$(cat <<'EOF'
feat(llm): generate() returns GenerationResult with TokenUsage (B7, #39)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 3: Real usage — Ollama and OpenAI-compat

**Files:**
- Modify: `backend/app/checkers/llm/_http_chat.py`
- Modify: `backend/app/checkers/llm/ollama.py`
- Modify: `backend/app/checkers/llm/openai_compat.py`
- Test: `backend/tests/test_providers.py`, `backend/tests/test_openai_compat.py`

**Interfaces:**
- Consumes: `GenerationResult`, `TokenUsage` from Task 2.
- Produces: `StreamEvent = tuple[str, str | int | TokenUsage]` with new `("usage", TokenUsage)` kind; overridable `HttpChatProvider._response_usage(data: dict) -> TokenUsage` (default `TokenUsage()`).

- [ ] **Step 1: Write the failing tests**

Append to `TestOllamaProvider` in `backend/tests/test_providers.py`:

```python
    async def test_generate_extracts_usage_counts(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "message": {"role": "assistant", "content": "[]"},
                    "prompt_eval_count": 120,
                    "eval_count": 30,
                },
            )

        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1",
            transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=120, output_tokens=30)

    async def test_generate_without_usage_reports_none(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"message": {"role": "assistant", "content": "[]"}}
            )

        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1",
            transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=None, output_tokens=None)
```

Append to `TestOllamaStreaming`:

```python
    async def test_streaming_extracts_usage_from_final_chunk(self) -> None:
        chunks = [
            {"message": {"content": "["}, "done": False},
            {"message": {"content": "]"}, "done": True,
             "prompt_eval_count": 80, "eval_count": 2},
        ]
        body = "\n".join(json.dumps(c) for c in chunks)
        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1",
            transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)),
        )
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.text == "[]"
        assert result.usage == TokenUsage(input_tokens=80, output_tokens=2)
```

Add `from app.checkers.llm.provider import TokenUsage` to the file's imports.

Append to `TestGenerate` in `backend/tests/test_openai_compat.py` (the `_sse` helper and provider construction match the file's existing streaming test):

```python
    async def test_generate_extracts_usage_counts(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert "stream_options" not in json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"role": "assistant", "content": "[]"}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 25},
                },
            )

        provider = OpenAICompatProvider(
            name="openai", base_url="https://api.test/v1", api_key="sk-test",
            model="gpt-5-mini", transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=100, output_tokens=25)

    async def test_streaming_requests_and_extracts_usage(self) -> None:
        body = _sse(
            {"choices": [{"delta": {"content": "["}}]},
            {"choices": [{"delta": {"content": "]"}}]},
            {"choices": [], "usage": {"prompt_tokens": 60, "completion_tokens": 7}},
            "[DONE]",
        )

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            # OpenAI only sends the final usage chunk when asked for it.
            assert payload["stream_options"] == {"include_usage": True}
            return httpx.Response(
                200, content=body, headers={"content-type": "text/event-stream"}
            )

        provider = OpenAICompatProvider(
            name="openai", base_url="https://api.test/v1", api_key="sk-test",
            model="gpt-5-mini", transport=httpx.MockTransport(handler),
        )
        progress: list[int] = []
        result = await provider.generate("s", "u", on_progress=progress.append)
        assert result.text == "[]"
        assert result.usage == TokenUsage(input_tokens=60, output_tokens=7)
        assert progress[-1] == 7  # exact-count correction still reported
```

```python
    async def test_streaming_extra_provider_gets_no_stream_options(self) -> None:
        # Extra compat endpoints (main.py extra_providers) may reject
        # unknown fields — only the built-in openai/mistral names opt in.
        body = _sse(
            {"choices": [{"delta": {"content": "[]"}}]},
            "[DONE]",
        )

        def handler(request: httpx.Request) -> httpx.Response:
            assert "stream_options" not in json.loads(request.content)
            return httpx.Response(
                200, content=body, headers={"content-type": "text/event-stream"}
            )

        provider = OpenAICompatProvider(
            name="groq", base_url="https://api.test/v1", api_key="sk-test",
            model="some-model", transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.text == "[]"
        assert result.usage == TokenUsage()

    async def test_usage_chunk_with_only_prompt_tokens_keeps_input_count(self) -> None:
        body = _sse(
            {"choices": [{"delta": {"content": "[]"}}]},
            {"choices": [], "usage": {"prompt_tokens": 60}},
            "[DONE]",
        )

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, content=body, headers={"content-type": "text/event-stream"}
            )

        provider = OpenAICompatProvider(
            name="openai", base_url="https://api.test/v1", api_key="sk-test",
            model="gpt-5-mini", transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.usage == TokenUsage(input_tokens=60, output_tokens=None)
```

Add `from app.checkers.llm.provider import TokenUsage` to the imports.

Also pin the absent-usage path for OpenAI-compat (spec §5: no usage fields ⇒ `TokenUsage(None, None)`, no error) with one line at the end of the existing `test_sends_chat_completions_request_and_returns_content`:

```python
        assert result.usage == TokenUsage()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_providers.py tests/test_openai_compat.py -v`
Expected: the new tests FAIL (usage is `TokenUsage(None, None)` where counts are expected; the `stream_options` assertion fails). The one-line absent-usage assertion already passes — it is a regression pin for the no-usage-fields path, not a RED test.

- [ ] **Step 3: Implement**

`backend/app/checkers/llm/_http_chat.py`:

1. Change the `StreamEvent` alias and its comment:

```python
# One parsed streaming line: ("content", text) appends and counts progress,
# ("tokens", n) reports an exact output-token count for progress,
# ("usage", TokenUsage) carries the final reported usage,
# ("done", "") ends the stream.
StreamEvent = tuple[str, str | int | TokenUsage]
```

2. Add a usage hook to `HttpChatProvider`:

```python
    def _response_usage(self, data: dict) -> TokenUsage:
        """Extract reported usage from a non-streaming response body.
        Default: nothing reported."""
        return TokenUsage()
```

3. Non-streaming `generate` uses it:

```python
            data = response.json()
            return GenerationResult(
                text=self._response_text(data), usage=self._response_usage(data)
            )
```

4. `_generate_streaming` tracks a usage variable:

```python
        parts: list[str] = []
        usage = TokenUsage()
        async with self._client() as client:
            async with client.stream("POST", self._chat_path, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    done = False
                    for kind, value in self._stream_events(line):
                        if kind == "content":
                            parts.append(str(value))
                            on_progress(len(parts))
                        elif kind == "tokens":
                            on_progress(int(value))
                        elif kind == "usage":
                            usage = value  # always a TokenUsage (StreamEvent contract)
                        elif kind == "done":
                            done = True
                    if done:
                        break
        return GenerationResult(text="".join(parts), usage=usage)
```

`backend/app/checkers/llm/ollama.py` — add after `_response_text`:

```python
    def _response_usage(self, data: dict) -> TokenUsage:
        return TokenUsage(
            input_tokens=data.get("prompt_eval_count"),
            output_tokens=data.get("eval_count"),
        )
```

and extend `_stream_events` (the final `done: true` object carries the counts):

```python
    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        # Ollama streams one NDJSON object per generated token; every parsed
        # line appends (even empty content), matching the pre-refactor
        # progress counting exactly. The final done-object also carries the
        # exact usage counts.
        if not line.strip():
            return
        data = json.loads(line)
        yield ("content", data.get("message", {}).get("content", ""))
        if data.get("done"):
            yield ("usage", self._response_usage(data))
```

Import `TokenUsage` from `.provider` in `ollama.py`.

`backend/app/checkers/llm/openai_compat.py` — import `TokenUsage` from `.provider`; add:

```python
    def _payload(self, system: str, user: str, stream: bool) -> dict:
        payload = super()._payload(system, user, stream)
        if stream and self.name in ("openai", "mistral"):
            # OpenAI sends the final usage chunk only when asked; Mistral
            # accepts the option too. Configured extra compat endpoints are
            # left untouched — some reject unknown fields, and a rejected
            # request would fail a previously-working deployment. They just
            # lack streaming usage telemetry.
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _response_usage(self, data: dict) -> TokenUsage:
        usage = data.get("usage") or {}
        return TokenUsage(
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )
```

and extend `_stream_events` so a usage chunk always yields the usage event — the progress correction only when an output count exists (a chunk carrying only `prompt_tokens` must not drop the input count):

```python
        usage = chunk.get("usage")
        if usage:
            if usage.get("completion_tokens") is not None:
                yield ("tokens", usage["completion_tokens"])
            yield ("usage", self._response_usage(chunk))
            return
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_providers.py tests/test_openai_compat.py -v`
Expected: all PASS (including the pre-existing streaming tests — their bodies lack usage fields, so they exercise the `TokenUsage()` default).

- [ ] **Step 5: Full-suite gate and commit**

Run: `uv run pytest -q` — zero failures, zero warnings.

```bash
git add backend/app/checkers/llm/_http_chat.py backend/app/checkers/llm/ollama.py backend/app/checkers/llm/openai_compat.py backend/tests/test_providers.py backend/tests/test_openai_compat.py
git commit -m "$(cat <<'EOF'
feat(llm): real token usage from Ollama and OpenAI-compat responses (B7, #39)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 4: Real usage — Claude and Bedrock

**Files:**
- Modify: `backend/app/checkers/llm/claude.py`
- Modify: `backend/app/checkers/llm/bedrock.py`
- Test: `backend/tests/test_providers.py`, `backend/tests/test_bedrock.py`

**Interfaces:**
- Consumes: `GenerationResult`, `TokenUsage` from Task 2.

- [ ] **Step 1: Write the failing tests**

The shared stubs (`_StubMessages`, `_FakeRuntimeClient.converse`) stay **without** usage fields — the existing non-streaming tests become the absent-usage regression pins (spec §5: no usage fields ⇒ `TokenUsage(None, None)`, no error). The new usage tests bring their own local stubs.

In `backend/tests/test_providers.py`, add one line at the end of the existing `test_generate_passes_prompts_and_returns_text`:

```python
        assert result.usage == TokenUsage()
```

and append to `TestClaudeProvider`:

```python
    async def test_generate_extracts_usage(self) -> None:
        class Usage:
            input_tokens = 55
            output_tokens = 9

        class Block:
            type = "text"
            text = "[]"

        class Response:
            content = [Block()]
            usage = Usage()

        class Messages:
            async def create(self, **kwargs: Any) -> Any:
                return Response()

        class Client:
            messages = Messages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=55, output_tokens=9)
```

In `_StubStreamingMessages.create`, extend the `event` factory and stream to carry a `message_start` with input usage:

```python
        def event(
            kind: str, text: str = "", tokens: int | None = None,
            input_tokens: int | None = None,
        ) -> Any:
            class Event:
                type = kind

            e = Event()
            if kind == "content_block_delta":
                d = Delta()
                d.text = text
                e.delta = d
            if kind == "message_start":
                class Usage:
                    pass

                usage = Usage()
                usage.input_tokens = input_tokens

                class Message:
                    pass

                message = Message()
                message.usage = usage
                e.message = message
            if tokens is not None:
                class Usage:
                    output_tokens = tokens

                e.usage = Usage()
            return e

        async def stream() -> Any:
            yield event("message_start", input_tokens=44)
            yield event("content_block_delta", "[")
            yield event("message_delta", tokens=7)
            yield event("content_block_delta", "]")
            yield event("message_delta", tokens=12)

        return stream()
```

and append to `TestClaudeStreaming`:

```python
    async def test_streaming_extracts_usage(self) -> None:
        class Client:
            messages = _StubStreamingMessages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.usage == TokenUsage(input_tokens=44, output_tokens=12)
```

In `backend/tests/test_bedrock.py`, the shared `_FakeRuntimeClient` stays unchanged. Add absent-usage pins to the two existing tests — at the end of `test_generate_uses_converse_and_returns_text`:

```python
        assert result.usage == TokenUsage()
```

and at the end of `test_generate_streams_and_reports_progress` (its metadata event carries only `outputTokens`):

```python
        assert result.usage == TokenUsage(input_tokens=None, output_tokens=5)
```

Append to `TestBedrockProvider`:

```python
    async def test_generate_extracts_usage(self) -> None:
        class Client(_FakeRuntimeClient):
            def converse(self, **kwargs: Any) -> dict[str, Any]:
                response = super().converse(**kwargs)
                response["usage"] = {"inputTokens": 70, "outputTokens": 5}
                return response

        provider = BedrockProvider(model="m", client=Client())
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=70, output_tokens=5)

    async def test_streaming_extracts_usage(self) -> None:
        events = [
            {"contentBlockDelta": {"delta": {"text": "[]"}}},
            {"metadata": {"usage": {"inputTokens": 66, "outputTokens": 5}}},
        ]
        provider = BedrockProvider(
            model="m", client=_FakeRuntimeClient(stream_events=events)
        )
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.usage == TokenUsage(input_tokens=66, output_tokens=5)
```

(No `asyncio.sleep(0)` in the usage tests: usage arrives via the `to_thread` return value, not via `call_soon_threadsafe`.)

Add `from app.checkers.llm.provider import TokenUsage` to `test_bedrock.py` imports (already added to `test_providers.py` in Task 3).

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_providers.py tests/test_bedrock.py -v`
Expected: new tests FAIL with `TokenUsage(None, None)`.

- [ ] **Step 3: Implement**

`backend/app/checkers/llm/claude.py` — add a module-level helper and use it in both paths:

```python
def _usage_of(source: Any) -> TokenUsage:
    """Read input/output token counts off an SDK usage object, tolerating
    absence — missing telemetry is never an error."""
    usage = getattr(source, "usage", None)
    return TokenUsage(
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
    )
```

Non-streaming: `return GenerationResult(text=text, usage=_usage_of(response))`.

Streaming:

```python
    async def _generate_streaming(
        self, kwargs: dict[str, Any], on_progress: ProgressCallback
    ) -> GenerationResult:
        parts: list[str] = []
        input_tokens: int | None = None
        output_tokens: int | None = None
        stream = await self._get_client().messages.create(**kwargs, stream=True)
        async for event in stream:
            if event.type == "content_block_delta" and event.delta.type == "text_delta":
                parts.append(event.delta.text)
            elif event.type == "message_start":
                input_tokens = _usage_of(event.message).input_tokens
            elif event.type == "message_delta":
                # Cumulative; the last one is the final count.
                output_tokens = event.usage.output_tokens
                on_progress(event.usage.output_tokens)
        return GenerationResult(
            text="".join(parts),
            usage=TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens),
        )
```

`backend/app/checkers/llm/bedrock.py`:

Non-streaming:

```python
        response = await asyncio.to_thread(lambda: self._get_client().converse(**kwargs))
        blocks = response["output"]["message"]["content"]
        text = "".join(block.get("text", "") for block in blocks)
        usage = response.get("usage") or {}
        return GenerationResult(
            text=text,
            usage=TokenUsage(
                input_tokens=usage.get("inputTokens"),
                output_tokens=usage.get("outputTokens"),
            ),
        )
```

`_stream_sync`:

```python
    def _stream_sync(
        self, kwargs: dict[str, Any], report: ProgressCallback
    ) -> GenerationResult:
        parts: list[str] = []
        input_tokens: int | None = None
        output_tokens: int | None = None
        response = self._get_client().converse_stream(**kwargs)
        for event in response["stream"]:
            if "contentBlockDelta" in event:
                text = event["contentBlockDelta"]["delta"].get("text", "")
                if text:
                    parts.append(text)
                    report(len(parts))
            elif "metadata" in event:
                usage = event["metadata"].get("usage", {})
                # Report only a count this event actually carries — never
                # re-report an accumulated value from an earlier event.
                if usage.get("outputTokens") is not None:
                    report(usage["outputTokens"])
                input_tokens = usage.get("inputTokens", input_tokens)
                output_tokens = usage.get("outputTokens", output_tokens)
        return GenerationResult(
            text="".join(parts),
            usage=TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens),
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_providers.py tests/test_bedrock.py -v`
Expected: all PASS, including the pre-existing streaming-progress assertions (`progress[-1] == 5`, `progress[:-1] == [1, 2]` — the metadata event still reports).

- [ ] **Step 5: Full-suite gate and commit**

Run: `uv run pytest -q` — zero failures, zero warnings.

```bash
git add backend/app/checkers/llm/claude.py backend/app/checkers/llm/bedrock.py backend/tests/test_providers.py backend/tests/test_bedrock.py
git commit -m "$(cat <<'EOF'
feat(llm): real token usage from Claude and Bedrock responses (B7, #39)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 5: `UnparseableResponseError` and `classify_failure`

**Files:**
- Modify: `backend/app/checkers/llm/checker.py:44-89` (`parse_response`)
- Modify: `backend/app/api/llm_gate.py` (add classifier)
- Modify: `backend/tests/test_llm_checker.py:46-47`
- Create: `backend/tests/test_failure_classification.py`

**Interfaces:**
- Consumes: `MissingApiKeyError` from Task 2.
- Produces (Task 6 relies on these exactly):
  - `UnparseableResponseError(response_chars: int)` in `app/checkers/llm/checker.py` — message `f"no JSON object or array in LLM response ({response_chars} chars)"`
  - `classify_failure(exc: BaseException) -> tuple[str, str]` in `app/api/llm_gate.py`

- [ ] **Step 1: Write the failing tests**

Replace `test_unparseable_response_returns_empty` in `backend/tests/test_llm_checker.py` with:

```python
    def test_unparseable_response_raises(self) -> None:
        # Spec §4.4: garbage output is a 'response'-stage failure, not a
        # silent zero-findings success.
        with pytest.raises(UnparseableResponseError) as excinfo:
            parse_findings("I could not find any issues.")
        # Guardrail: the message must never quote the response text.
        assert "could not find" not in str(excinfo.value)

    def test_object_without_findings_key_raises(self) -> None:
        with pytest.raises(UnparseableResponseError):
            parse_response('{"verdict": "fine"}')

    def test_wrong_shaped_object_with_nested_array_raises(self) -> None:
        # extract_json_array's substring scan would find the nested [] —
        # a top-level object that is not a findings envelope must raise
        # regardless of what it contains.
        with pytest.raises(UnparseableResponseError):
            parse_response('{"alternatives": []}')

    def test_envelope_with_empty_findings_is_success(self) -> None:
        findings, scorecard = parse_response('{"findings": []}')
        assert findings == []
        assert scorecard is None
```

Add `import pytest` and extend the checker import line with `UnparseableResponseError`.

Create `backend/tests/test_failure_classification.py`:

```python
"""classify_failure maps LLM-path exceptions to the fail_stage enum
(spec §4.3). Classification must never raise."""

import json

import httpx

from app.api.llm_gate import classify_failure
from app.checkers.llm.checker import UnparseableResponseError
from app.checkers.llm.provider import MissingApiKeyError


class TestStageMapping:
    def test_unparseable_response_is_response_stage(self) -> None:
        stage, detail = classify_failure(UnparseableResponseError(1234))
        assert stage == "response"
        assert "UnparseableResponseError" in detail
        assert "1234" in detail

    def test_missing_api_key_is_request_stage(self) -> None:
        stage, _ = classify_failure(MissingApiKeyError("No API key for 'openai'"))
        assert stage == "request"

    def test_httpx_transport_errors_are_request_stage(self) -> None:
        for exc in (httpx.ConnectError("refused"), httpx.ReadTimeout("slow")):
            assert classify_failure(exc)[0] == "request"

    def test_http_status_error_is_provider_stage_with_status(self) -> None:
        request = httpx.Request("POST", "https://api.test/v1/chat")
        response = httpx.Response(503, request=request)
        exc = httpx.HTTPStatusError("boom", request=request, response=response)
        stage, detail = classify_failure(exc)
        assert stage == "provider"
        assert "HTTPStatusError" in detail
        assert "503" in detail

    def test_provider_body_decode_failure_is_response_stage(self) -> None:
        # An HTTP 200 whose body fails json.loads is broken output on
        # reception — 'response', not 'provider'.
        try:
            json.loads("not json at all")
        except json.JSONDecodeError as exc:
            stage, detail = classify_failure(exc)
        assert stage == "response"
        assert "JSONDecodeError" in detail

    def test_botocore_client_error_status_from_response_dict(self) -> None:
        # botocore's ClientError carries a dict response, not an object
        # with .status_code — the status lives under ResponseMetadata.
        class ClientError(Exception):
            response = {"ResponseMetadata": {"HTTPStatusCode": 429}}

        stage, detail = classify_failure(ClientError("throttled"))
        assert stage == "provider"
        assert "(429)" in detail

    def test_sdk_connection_errors_matched_by_class_name(self) -> None:
        # anthropic/botocore types are matched by name through the MRO so
        # this module never imports those SDKs.
        class APIConnectionError(Exception):
            pass

        class NoCredentialsError(Exception):
            pass

        assert classify_failure(APIConnectionError("down"))[0] == "request"
        assert classify_failure(NoCredentialsError())[0] == "request"

    def test_unknown_exception_defaults_to_provider_stage(self) -> None:
        stage, detail = classify_failure(RuntimeError("model exploded"))
        assert stage == "provider"
        assert detail == "RuntimeError: model exploded"


class TestDetailFormat:
    def test_detail_collapses_whitespace_and_truncates(self) -> None:
        _, detail = classify_failure(RuntimeError("a  b\n\nc " * 200))
        assert "\n" not in detail
        assert "  " not in detail.removeprefix("RuntimeError: ")
        assert len(detail) <= 200

    def test_messageless_exception_keeps_class_name(self) -> None:
        _, detail = classify_failure(ValueError())
        assert detail == "ValueError"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_llm_checker.py tests/test_failure_classification.py -v`
Expected: FAIL — `UnparseableResponseError`/`classify_failure` do not exist.

- [ ] **Step 3: Implement `UnparseableResponseError` in `checker.py`**

Add after the `_CODE_FENCE` definition:

```python
class UnparseableResponseError(Exception):
    """The LLM response contained neither a JSON object envelope nor a bare
    array — a 'response'-stage failure (spec §4.4).

    The message carries only the response length, never the text itself:
    it feeds the ledger's fail_detail, which stores metadata only."""

    def __init__(self, response_chars: int) -> None:
        super().__init__(
            f"no JSON object or array in LLM response ({response_chars} chars)"
        )
```

Replace the tail of `parse_response` (keep the envelope branch unchanged) and add the `_top_level_json` helper below it:

```python
    data = extract_json_object(response)
    if data is not None and isinstance(data.get("findings"), list):
        scorecard = None
        if data.get("scorecard") is not None:
            try:
                scorecard = Scorecard.model_validate(data["scorecard"])
            except ValidationError:
                scorecard = None
        return ParsedResponse(_validate_findings(data["findings"]), scorecard)
    if isinstance(_top_level_json(response), dict):
        # The whole response IS a JSON object but not a findings envelope
        # (e.g. {"alternatives": []}) — a nested array inside it must not
        # be mistaken for a bare findings array by the substring scan below.
        raise UnparseableResponseError(len(response))
    array = extract_json_array(response)
    if array is None:
        raise UnparseableResponseError(len(response))
    return ParsedResponse(_validate_findings(array), None)


def _top_level_json(response: str) -> Any:
    """The response's primary JSON value (whole or fence-stripped); None
    when neither parses. Substring extraction deliberately does not count:
    prose around a bare array must keep falling through to the array path."""
    for candidate in (response, _CODE_FENCE.sub("", response).strip()):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None
```

Update `parse_response`'s docstring first line to say unparseable input raises `UnparseableResponseError` (a valid envelope with an empty findings list, or a parseable response whose individual items all fail validation, remains a success).

- [ ] **Step 4: Implement `classify_failure` in `llm_gate.py`**

Add `import httpx`, `import json`, and `from app.checkers.llm.checker import UnparseableResponseError`; extend the existing `app.checkers.llm.provider` import with `MissingApiKeyError`. Add at module level:

```python
_FAIL_DETAIL_LIMIT = 200

# Exception class names (searched through the MRO) meaning the request never
# reached provider processing: connection, timeout, credentials. Matched by
# name so this module needs neither the anthropic nor the botocore SDK.
_REQUEST_STAGE_CLASS_NAMES = frozenset({
    "APIConnectionError",      # anthropic (APITimeoutError subclasses it)
    "NoCredentialsError",      # botocore
    "NoRegionError",           # botocore
    "EndpointConnectionError", # botocore
    "ConnectTimeoutError",     # botocore
})


def classify_failure(exc: BaseException) -> tuple[str, str]:
    """Map an exception from the LLM path to (fail_stage, fail_detail)
    (spec §4.3). Never raises: an unrecognized exception lands as
    'provider' — an in-flight run that raised is by definition past the
    request stage — with its class preserved in the detail for later
    reclassification."""
    detail = _fail_detail(exc)
    if isinstance(exc, (UnparseableResponseError, json.JSONDecodeError)):
        # JSONDecodeError on this path means the provider returned a body
        # that fails to decode — broken output on reception (spec §4.3).
        return "response", detail
    if isinstance(exc, MissingApiKeyError):
        return "request", detail
    if isinstance(exc, httpx.TransportError):
        # ConnectError, all timeout flavors, protocol errors — never got a
        # response. httpx.HTTPStatusError is NOT a TransportError and falls
        # through to 'provider'.
        return "request", detail
    names = {klass.__name__ for klass in type(exc).__mro__}
    if names & _REQUEST_STAGE_CLASS_NAMES:
        return "request", detail
    return "provider", detail


def _fail_detail(exc: BaseException) -> str:
    """Error metadata only — exception class, HTTP status, first 200
    whitespace-collapsed chars of the message. Never response bodies."""
    try:
        message = " ".join(str(exc).split())
    except Exception:  # a broken __str__ must not break classification
        message = ""
    status = getattr(exc, "status_code", None)
    if status is None:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        if status is None and isinstance(response, dict):
            # botocore ClientError carries a dict response; its status
            # lives under ResponseMetadata, not a .status_code attribute.
            status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    head = type(exc).__name__ if status is None else f"{type(exc).__name__} ({status})"
    detail = f"{head}: {message}" if message else head
    return detail[:_FAIL_DETAIL_LIMIT]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_llm_checker.py tests/test_failure_classification.py -v`
Expected: all PASS.

- [ ] **Step 6: Full-suite gate**

Run: `uv run pytest -q`
Expected: all PASS — no existing checks-API test feeds unparseable output (verified during planning; `FakeProvider("[]")` and the envelope responses all still parse). If anything fails here, the failure is new information: read it, fix the cause, do not weaken `parse_response`.

- [ ] **Step 7: Commit**

```bash
git add backend/app/checkers/llm/checker.py backend/app/api/llm_gate.py backend/tests/test_llm_checker.py backend/tests/test_failure_classification.py
git commit -m "$(cat <<'EOF'
feat(llm): UnparseableResponseError + central failure classifier (B5, #38)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

### Task 6: Settle usage and classification at the three call sites; docs

**Files:**
- Modify: `backend/app/checkers/llm/checker.py:92-148` (`LLMCheckResult`, `check`)
- Modify: `backend/app/api/checks.py:152-204` (`_run_llm`)
- Modify: `backend/app/api/suggestions.py:99-166`
- Modify: `backend/app/api/documents.py:237-284`
- Modify: `docs/backend-architecture.md` (ledger schema + provider protocol sections)
- Test: `backend/tests/test_check_api.py`, `backend/tests/test_suggestions_api.py`, `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: `LlmReservation.finish(status, *, input_tokens, output_tokens, fail_stage, fail_detail)` (Task 1); `GenerationResult`, `TokenUsage`, `FakeProvider(usage=...)` (Task 2); `classify_failure`, `UnparseableResponseError` (Task 5).
- Produces: `LLMCheckResult.usage: TokenUsage`.

- [ ] **Step 1: Write the failing endpoint tests**

In `backend/tests/test_check_api.py`: the ledger helper is **module-level** `_read_usage_rows(db_path)` at line ~840 (takes a `db_path`), the module-level `make_client(tmp_path, provider)` at line 33 builds its `Settings` with `db_path=tmp_path / "test.db"`, and completion is observed by draining SSE (`_read_sse_events`) — there is no `wait_for_done` helper.

First, extend the existing `test_provider_failure_writes_a_failed_row` (line ~887) with two assertions after its `assert rows[0]["status"] == "failed"`:

```python
        assert rows[0]["fail_stage"] == "provider"
        assert rows[0]["fail_detail"] == "RuntimeError: model exploded"
```

Then add to `TestCheckMetering`:

```python
    def test_completed_run_settles_provider_usage(self, tmp_path: Path) -> None:
        # progress_steps make the approximation (41) available, so this
        # pins that reported usage WINS over the approximation (spec §3.3) —
        # without them, an inverted precedence would still pass.
        provider = FakeProvider(
            LLM_RESPONSE, progress_steps=[5, 40, 41],
            usage=TokenUsage(input_tokens=100, output_tokens=20),
        )
        with make_client(tmp_path, provider) as client:
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                _read_sse_events(stream)
        (row,) = _read_usage_rows(tmp_path / "test.db")
        assert row["status"] == "completed"
        assert row["input_tokens"] == 100
        assert row["output_tokens"] == 20  # reported count, not the 41 approximation
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None

    def test_unparseable_response_is_response_stage_failure(self, tmp_path: Path) -> None:
        # Spec §4.4: garbage output no longer settles 'completed' with zero
        # findings; the detail records length metadata, never the text —
        # and the usage generate() already burned still settles (spec §3.3).
        provider = FakeProvider(
            "I could not find any issues worth reporting.",
            usage=TokenUsage(input_tokens=90, output_tokens=15),
        )
        with make_client(tmp_path, provider) as client:
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                events = _read_sse_events(stream)
            assert any(name == "checker_error" for name, _ in events)
        (row,) = _read_usage_rows(tmp_path / "test.db")
        assert row["status"] == "failed"
        assert row["fail_stage"] == "response"
        assert "UnparseableResponseError" in row["fail_detail"]
        assert "could not find" not in row["fail_detail"]  # guardrail
        assert row["input_tokens"] == 90   # usage survives the parse failure
        assert row["output_tokens"] == 15

    def test_empty_findings_envelope_still_completes(self, tmp_path: Path) -> None:
        with make_client(tmp_path, FakeProvider('{"findings": []}')) as client:
            post = client.post(
                "/api/checks",
                json={"text": "This is very nice.", "language": "en",
                      "checkers": ["llm"]},
            )
            check_id = post.json()["check_id"]
            with client.stream("GET", f"/api/checks/{check_id}/events") as stream:
                _read_sse_events(stream)
            final = client.get(f"/api/checks/{check_id}").json()
            assert final["findings"] == []
        (row,) = _read_usage_rows(tmp_path / "test.db")
        assert row["status"] == "completed"
        assert row["fail_stage"] is None
```

Add `TokenUsage` to the file's `app.checkers.llm.provider` import.

In `backend/tests/test_suggestions_api.py`, `TestSuggestionsMetering` (line ~379) builds its app inline per test (`Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")` → `create_app` → `TestClient` → `auth_headers`) and reads rows via the **module-level** `_read_usage_rows(settings.db_path)` (line ~364). No new tests — extend three existing ones in place:

1. `test_suggestion_writes_a_completed_ledger_row` (line ~435): give its `FakeProvider` a usage argument —

```python
        app.state.provider_factory = lambda name=None, model=None: FakeProvider(
            json.dumps(["excellent"]),
            usage=TokenUsage(input_tokens=40, output_tokens=6),
        )
```

— and append to its row assertions:

```python
        assert row["input_tokens"] == 40
        assert row["output_tokens"] == 6
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None
```

2. `test_unparseable_response_writes_failed_and_returns_502` (line ~455): append to its ledger assertions:

```python
        assert rows[0]["fail_stage"] == "response"
        assert rows[0]["fail_detail"] == "LLM response contained no JSON array"
```

3. The provider-exception metering test directly below it (the `BrokenProvider` one around line ~476): append to its ledger assertions:

```python
        assert rows[0]["fail_stage"] == "provider"
        assert rows[0]["fail_detail"] == "RuntimeError: model exploded"
```

Add `TokenUsage` to the file's `app.checkers.llm.provider` import.

In `backend/tests/test_documents_api.py`, the rows helper is the **module-level** `_read_usage_rows(db_path)` at line ~288, read as `_read_usage_rows(authed_client.app.state.settings.db_path)` (see `test_generate_name_writes_a_ledger_row` at line ~303).

1. Add next to that test (set `provider_factory` directly — the file's `with_provider` helper has no usage parameter):

```python
def test_generate_name_settles_usage(authed_client):
    doc = make_doc(authed_client, text="A long enough body about widget assembly.")
    authed_client.app.state.provider_factory = lambda name=None, model=None: (
        FakeProvider('"Widget Assembly Guide."',
                     usage=TokenUsage(input_tokens=30, output_tokens=8))
    )
    response = authed_client.post(f"/api/documents/{doc['id']}/generate-name")
    assert response.status_code == 200

    rows = _read_usage_rows(authed_client.app.state.settings.db_path)
    assert len(rows) == 1
    assert rows[0]["status"] == "completed"
    assert rows[0]["input_tokens"] == 30
    assert rows[0]["output_tokens"] == 8
```

2. Extend the existing `test_generate_name_unusable_title_falls_back_and_marks_run_failed` (line ~318) — append to its ledger assertions:

```python
    assert rows[0]["fail_stage"] == "response"
    assert rows[0]["fail_detail"] == "title generation produced no usable title"
```

Add `TokenUsage` to the file's `app.checkers.llm.provider` import.

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_check_api.py tests/test_suggestions_api.py tests/test_documents_api.py -v`
Expected: the new tests and the extended assertions FAIL — tokens land NULL (or approximate), `fail_stage` is NULL, unparseable settles completed. Everything else stays green.

- [ ] **Step 3: Pass usage through `LLMChecker`**

In `backend/app/checkers/llm/checker.py` — import `TokenUsage` (extend the `.provider` import); extend the result dataclass:

```python
@dataclass
class LLMCheckResult:
    findings: list[Finding]
    scorecard: Scorecard | None
    usage: TokenUsage = TokenUsage()
```

and in `check`:

```python
        result = await self.provider.generate(system, user, on_progress)
        try:
            raw_findings, scorecard = parse_response(result.text)
        except UnparseableResponseError as exc:
            # generate() succeeded and burned real tokens before the parse
            # failed — carry the usage out with the exception so the ledger
            # can still settle exact counts on this failed run (spec §3.3:
            # "whatever usage was obtained before the failure").
            exc.usage = result.usage
            raise
```

…anchoring loop reads `text` (the document) exactly as before, and the return becomes:

```python
        return LLMCheckResult(findings=findings, scorecard=scorecard, usage=result.usage)
```

In `UnparseableResponseError` (Task 5), add a class-level annotation so the attach is a declared part of the contract, not an ad-hoc attribute:

```python
    usage: "TokenUsage | None" = None
```

(with `TokenUsage` imported in `checker.py` — this task adds that import anyway).

- [ ] **Step 4: Settle in `_run_llm` (`backend/app/api/checks.py`)**

Imports: extend `from app.api.llm_gate import ...` with `classify_failure`; add `TokenUsage` to the `app.checkers.llm.provider` import; add `UnparseableResponseError` to the existing `app.checkers.llm.checker` import. Replace the body from `status = "completed"` down:

```python
    status = "completed"
    usage = TokenUsage()
    fail_stage: str | None = None
    fail_detail: str | None = None
    try:
        checker = LLMChecker(provider, vet=vet, dictionaries_dir=dictionaries_dir)
        result = await checker.check(
            text, language, on_progress=on_progress, instructions=instructions
        )
        usage = result.usage
        job.add_findings("llm", drop_duplicates(result.findings, job.findings))
        if result.scorecard is not None:
            job.set_scorecard(result.scorecard)
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except Exception as exc:
        status = "failed"
        fail_stage, fail_detail = classify_failure(exc)
        # An unparseable response carries the usage generate() already
        # obtained (see LLMChecker.check) — settle those real counts.
        if isinstance(exc, UnparseableResponseError) and exc.usage is not None:
            usage = exc.usage
        error = str(exc) or type(exc).__name__
        logger.warning("llm check failed (provider %s): %s", provider.name, error)
        job.emit("checker_error", {"checker": "llm", "error": error})
    finally:
        try:
            # Real counts when the provider reported them; the progress
            # approximation remains the output fallback (spec §3.3).
            output_tokens = usage.output_tokens
            if output_tokens is None and latest_tokens > 0:
                output_tokens = latest_tokens
            reservation.finish(
                status,
                input_tokens=usage.input_tokens,
                output_tokens=output_tokens,
                fail_stage=fail_stage,
                fail_detail=fail_detail,
            )
        except Exception:
            logger.exception("ledger settle failed for run %s; 900s sweep will reclaim it", job.id)
        job.finish()
```

(The existing comment block above the `try` about exception-safe settling stays.)

- [ ] **Step 5: Settle in suggestions (`backend/app/api/suggestions.py`)**

Imports: add `from app.api.llm_gate import classify_failure` (extend the existing import) and `from app.checkers.llm.provider import TokenUsage`. Replace from `status = "completed"` down (response-building middle unchanged):

```python
    status = "completed"
    usage = TokenUsage()
    fail_stage: str | None = None
    fail_detail: str | None = None
    try:
        result = await provider.generate(system, prompt)
        usage = result.usage
        items = extract_json_array(result.text)
        if items is None:
            status = "failed"
            fail_stage = "response"
            fail_detail = "LLM response contained no JSON array"
            raise HTTPException(502, "LLM response contained no JSON array")
        ...  # suggestions/vetting/response construction — UNCHANGED, keep as-is
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except HTTPException:
        raise
    except Exception as exc:
        status = "failed"
        fail_stage, fail_detail = classify_failure(exc)
        detail = str(exc) or type(exc).__name__
        raise HTTPException(502, f"LLM request failed: {detail}") from exc
    finally:
        reservation.finish(
            status,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            fail_stage=fail_stage,
            fail_detail=fail_detail,
        )
```

(The `...` marks the existing lines 115–155 — they are not rewritten by this task; only the frame around them changes.)

- [ ] **Step 6: Settle in naming (`backend/app/api/documents.py`)**

Imports: add `classify_failure` to the `app.api.llm_gate` import; add `from app.checkers.llm.provider import TokenUsage`. Replace the inner naming block (the `if provider is not None:` body):

```python
            if provider is not None:
                assert reservation is not None
                name_status = "completed"
                usage = TokenUsage()
                fail_stage: str | None = None
                fail_detail: str | None = None
                try:
                    system, prompt = build_title_prompt(document.text, document.language)
                    result = await provider.generate(system, prompt)
                    usage = result.usage
                    title = clean_title(result.text)
                    if title is None:
                        # The provider call succeeded but produced nothing
                        # usable -- a burned-token run with no value, just
                        # like suggestions.py's unparseable-response case.
                        # The silent local fallback below is unaffected;
                        # only the ledger's own status changes.
                        name_status = "failed"
                        fail_stage = "response"
                        fail_detail = "title generation produced no usable title"
                except asyncio.CancelledError:
                    name_status = "cancelled"
                    raise
                except Exception as exc:
                    name_status = "failed"
                    fail_stage, fail_detail = classify_failure(exc)
                    raise
                finally:
                    reservation.finish(
                        name_status,
                        input_tokens=usage.input_tokens,
                        output_tokens=usage.output_tokens,
                        fail_stage=fail_stage,
                        fail_detail=fail_detail,
                    )
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `uv run pytest tests/test_check_api.py tests/test_suggestions_api.py tests/test_documents_api.py -v`
Expected: all PASS — new and pre-existing (the pre-existing approximate-output-tokens test still passes via the fallback; FakeProvider's default usage is `TokenUsage()`).

- [ ] **Step 8: Mutation-verify the response-text guardrail**

Temporarily change `UnparseableResponseError.__init__` to embed the response text in its message (`super().__init__(response_text)` given a `response_text` argument passed from `parse_response`), run `uv run pytest tests/test_check_api.py -v -k unparseable` — the `"could not find" not in row["fail_detail"]` assertion must FAIL. Restore, confirm green. (test_llm_checker's message assertion from Task 5 double-covers this; both must actually fail under the mutation.)

- [ ] **Step 9: Update the architecture doc**

In `docs/backend-architecture.md`:
- Ledger/`llm_usage` section: add `fail_stage`/`fail_detail` (failed-path only, enum values, metadata-only guardrail, migration note) and note that `input_tokens`/`output_tokens` now carry provider-reported counts (checks fall back to the progress approximation for output).
- Provider/LLM section: `generate` returns `GenerationResult(text, usage: TokenUsage)`; per-provider usage sources (one line each); `classify_failure` in `llm_gate.py`; `UnparseableResponseError` semantics for the checks path. Note that `stream_options: {"include_usage": true}` is sent only for the built-in `openai`/`mistral` names — configured extra compat endpoints are left untouched (some reject unknown fields) and simply lack streaming usage telemetry.

- [ ] **Step 10: Full-suite gate and commit**

Run: `uv run pytest -q` — zero failures, zero warnings.

```bash
git add backend/app/checkers/llm/checker.py backend/app/api/checks.py backend/app/api/suggestions.py backend/app/api/documents.py backend/tests/ docs/backend-architecture.md
git commit -m "$(cat <<'EOF'
feat(ledger): settle real usage and failure classification at all three LLM paths (B5+B7, #38 #39)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ
EOF
)"
```

---

## Completion (after all tasks)

1. Final whole-branch review per superpowers:subagent-driven-development (most capable model), one fix wave + scoped re-review; park residuals with rulings.
2. Push branch `b5-b7-ledger-telemetry`, open the PR with `Closes #38` / `Closes #39`, request Copilot review, spawn the review watcher.
3. Append the LOGBOOK entry (`docs/LOGBOOK.md`, referenced by PR number) and move #38/#39 to **In review** on the project board.
4. Owner merges; then sync main, clean up branch, move both issues to **Done**.
