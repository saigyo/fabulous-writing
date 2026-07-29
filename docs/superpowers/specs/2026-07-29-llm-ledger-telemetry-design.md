# LLM Ledger Telemetry: Failure Classification & Real Token Usage (B5 + B7)

**Date:** 2026-07-29
**Issues:** [#38 (B5)](https://github.com/saigyo/fabulous-writing/issues/38), [#39 (B7)](https://github.com/saigyo/fabulous-writing/issues/39) — one combined backend follow-up, decided as a natural pairing when both were filed.
**Owner decisions carried in:** fail-stage enum and fail-detail guardrail decided 2026-07-27 in the PR #30 review discussion; uniform `failed` semantics (parse failures included) shipped with M5 (PR #30 round 5).

## 1. Motivation

Both items share the never-backfillable argument: every week without these
columns is history that can never be recovered.

- **B5:** `status='failed'` conflates every error shape from
  provider-unreachable to unparseable output. Failure rows carry no
  analytical value beyond their count.
- **B7:** every provider API reports exact input/output token counts in its
  responses, and we throw them away. The checks path scrapes an approximate
  output count from the streaming progress callback; suggestions and naming
  record NULL. `input_tokens`/`output_tokens` columns exist since M5 but are
  never filled with real values.

B6 (credit budgeting, #40) builds on both; neither item exposes any API or
frontend surface itself.

## 2. Scope

Backend only. One branch/PR closing both issues (`Closes #38`, `Closes #39`
in the PR body). No new endpoints, no response-shape changes, no frontend
changes, no new Settings knobs.

**In scope beyond pure classification (owner-approved 2026-07-28):** the
checks path currently settles an *unparseable* LLM response as `'completed'`
with zero findings — garbage output and a legitimate "no issues found" are
indistinguishable. That hole closes here: unparseable responses become
`failed` runs with `fail_stage='response'`, aligning checks with the
suggestions and naming paths per the M5 uniform-failed decision.

## 3. B7 — provider usage reporting

### 3.1 Protocol change

`LLMProvider.generate` returns a result object instead of a bare string
(`app/checkers/llm/provider.py`):

```python
@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class GenerationResult:
    text: str
    usage: TokenUsage
```

```python
async def generate(
    self, system: str, user: str, on_progress: ProgressCallback | None = None
) -> GenerationResult: ...
```

`None` means "the provider did not report this count" — never 0, which is a
real reported value. The `on_progress` callback is unchanged: it remains the
live-UI progress mechanism and keeps its existing approximate semantics.

### 3.2 Per-implementation usage sources

| Implementation | Non-streaming | Streaming |
|---|---|---|
| Ollama (native API) | `prompt_eval_count` / `eval_count` in the response body | same fields on the final `done: true` NDJSON object |
| OpenAI-compat (openai, mistral) | `usage.prompt_tokens` / `usage.completion_tokens` | payload gains `stream_options: {"include_usage": true}` for the built-in `openai`/`mistral` names only — configured extra compat endpoints are left untouched (some reject unknown fields) and may simply lack streaming usage; the final usage chunk carries both counts |
| Claude | `response.usage.input_tokens` / `.output_tokens` | `message_start` event (input) + `message_delta` events (output) |
| Bedrock (Converse) | `response["usage"]["inputTokens"/"outputTokens"]` | the `metadata` event's `usage` (already read for progress; now kept) |
| FakeProvider | optional `usage=` constructor argument, default `TokenUsage()` (both `None`) | same |

`_http_chat.py`'s `StreamEvent` vocabulary gains a usage event so Ollama and
OpenAI-compat can hand both counts up from their line parsers; the existing
`("tokens", n)` progress-correction event stays as-is for progress purposes.

A provider that cannot find usage in a response returns
`TokenUsage(None, None)` — missing telemetry is never an error and must not
fail an otherwise-successful run.

### 3.3 Settling into the ledger

At `finish_run`, all three LLM-invoking paths settle real counts:

- **Checks** (`_run_llm`): `input_tokens` from `usage.input_tokens` (no
  approximation exists or is invented); `output_tokens` prefers
  `usage.output_tokens` and falls back to the existing progress-callback
  approximation only when the provider reported `None`.
- **Suggestions, naming:** both counts from `usage`, or NULL. (Today they
  record NULL unconditionally.)

`LLMChecker.check` passes usage through via `LLMCheckResult`; the
suggestions and naming call sites read it off `GenerationResult` directly.

Failed runs store whatever usage was obtained before the failure — usually
NULL, since an exception from `generate` yields no result object. No partial
usage is scraped out of exceptions.

## 4. B5 — failure classification

### 4.1 Schema

Two nullable TEXT columns on `llm_usage`, written **only** on the failed
path:

- `fail_stage` — one of:
  - `'request'`: unreachable / auth / timeout before or while sending
  - `'provider'`: the provider's API errored while processing
  - `'response'`: broken or unparseable output on reception
- `fail_detail` — error *metadata* only: exception class name, HTTP status
  where present, first 200 whitespace-collapsed characters of the exception
  message. **Never raw provider response bodies**, which can quote document
  text — the ledger deliberately stores `text_chars`, not text. This
  guardrail is binding.

Fresh databases get the columns in `_SCHEMA` with
`CHECK (fail_stage IN ('request','provider','response') OR fail_stage IS NULL)`.
Existing databases get them via the established `migrate_columns` helper
(`app/services/_sqlite.py`); migrated tables skip the CHECK — SQLite cannot
add one without a table rebuild. The enum is enforced in code either way —
`finish_run` rejects an unknown non-null stage with a `ValueError`, so the
guarantee holds on migrated databases too — and unlike `status`, a
malformed `fail_stage` cannot leak a concurrency slot.

### 4.2 Write path

`UsageStore.finish_run` gains keyword-only `fail_stage: str | None = None`
and `fail_detail: str | None = None`. **The store nulls both unless
`status == 'failed'`** — a caller passing stage/detail alongside
`'completed'` or `'cancelled'` gets NULLs written, by construction, not by
caller discipline. `LlmReservation.finish` (`app/api/llm_gate.py`) forwards
both.

### 4.3 Classification

One central helper next to the ledger consumers (`app/api/llm_gate.py`):

```python
def classify_failure(exc: BaseException) -> tuple[str, str]:
    """Map an exception from the LLM path to (fail_stage, fail_detail)."""
```

| Exception shape | Stage |
|---|---|
| httpx transport errors (`ConnectError`, `TimeoutException`, …), `MissingApiKeyError` (raised by both the OpenAI-compat and Claude client constructors when their env key is absent), botocore credential/endpoint/read-timeout errors, and any failure carrying HTTP status 401/403 (rejected credentials, whichever SDK surfaced them) | `'request'` |
| `httpx.HTTPStatusError`, anthropic SDK API-status errors, botocore `ClientError` | `'provider'` |
| `UnparseableResponseError` (new, §4.4); `json.JSONDecodeError` (the provider returned a body that fails to decode) | `'response'` |
| anything unrecognized | `'provider'`, class name preserved in detail |

The unknown-exception default is `'provider'` because an in-flight run that
raised is by definition past the request stage; the detail string preserves
the actual class for later reclassification. SDK exception types are matched
tolerantly (by module/class name where importing the SDK lazily would be
awkward) — classification must never itself raise.

`fail_detail` format: `"{ExceptionClass}: {message}"` with whitespace
collapsed and the whole string truncated to 200 characters; for HTTP-status
errors the status code is included. Exceptions constructed by our own code
for the `'response'` stage must not embed the response text in their message
(length is fine, content is not).

### 4.4 Closing the checks-path parse hole

`parse_response` (`app/checkers/llm/checker.py`) raises a new
`UnparseableResponseError` when the response contains **neither** a JSON
object envelope **nor** a bare JSON array. A response whose top-level JSON
value is valid but neither an envelope nor an array — a wrong-shaped
object (`{"alternatives": []}`), a quoted string (`'"[]"'`), a bare
scalar — also raises: bracket characters inside such a value must not be
mistaken for a bare findings array. A valid envelope with an empty
findings list — the model legitimately reporting "no issues" — remains a
success, as does a parseable response whose individual items fail
validation (item-level tolerance is unchanged). The prose-embedded bare
array fallback (response text around a top-level JSON array) keeps
working.

Effects in `_run_llm`: the existing `except Exception` arm settles the run
`failed` with stage `'response'` via the classifier, and the existing SSE
`checker_error` event fires exactly as for any other failure. No new event
shapes.

Call sites that already *know* the stage pass it explicitly instead of
sniffing exception types:

- **Suggestions:** the existing "response contained no JSON array" 502 path
  settles with `fail_stage='response'` and its own message as
  `fail_detail` ("LLM response contained no JSON array").
- **Naming:** the `clean_title(...) is None` burned-token case settles with
  `fail_stage='response'` and `fail_detail` "title generation produced no
  usable title".

All other failure arms in the three paths call `classify_failure(exc)`.

## 5. Testing

- **Usage store:** failed-path round-trip of both columns; NULLs written on
  `completed`/`cancelled` even when a caller passes stage/detail (guard
  test); migration test opening a pre-B5 schema and asserting the columns
  appear with NULLs on old rows.
- **Providers:** per-implementation usage extraction, streaming and
  non-streaming, using the existing fake-transport/fake-client patterns; a
  response without usage fields yields `TokenUsage(None, None)` and no
  error.
- **Classifier:** unit table with a representative exception per stage plus
  the unknown-exception default; classification never raises.
- **Endpoint level:** a failing check/suggestion/naming run lands `failed`
  with the correct stage and a `fail_detail` containing the exception class
  but **not** the response text (guard test); a completed run lands
  FakeProvider's configured token counts; checks-path garbage now settles
  `failed`/`'response'` while a valid-but-empty envelope still settles
  `completed` with zero findings.
- Guard tests are mutation-verified per standing praxis: delete the guard,
  watch the test fail, restore.

## 6. Binding constraints (restated)

- The live database `backend/data/fabulous.db` is never read or written by
  tests; every test passes `tmp_path`-based `Settings`.
- No new Settings/config/env knobs anywhere in this work.
- Secrets from environment only; never in repo, DB, or logs.
- `fail_detail` never carries document text or raw provider response
  bodies.
- Never widen a wall-clock test bound.
- Backend gate before every commit: `uv run pytest -q` with zero warnings.
