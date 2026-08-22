"""classify_failure maps LLM-path exceptions to the fail_stage enum
(spec §4.3). Classification must never raise."""

import json

import httpx

from app.api.llm_gate import classify_failure
from app.checkers.llm.checker import UnparseableResponseError
from app.checkers.llm.provider import MissingApiKeyError, TruncatedResponseError


class TestStageMapping:
    def test_unparseable_response_is_response_stage(self) -> None:
        stage, detail = classify_failure(UnparseableResponseError(1234))
        assert stage == "response"
        assert "UnparseableResponseError" in detail
        assert "1234" in detail

    def test_truncated_response_is_response_stage(self) -> None:
        # A response cut off at the max_tokens cap is broken output on
        # reception — 'response', like the unparseable case it used to
        # masquerade as.
        stage, detail = classify_failure(TruncatedResponseError(2973, 4096))
        assert stage == "response"
        assert "TruncatedResponseError" in detail
        assert "4096" in detail

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

        class ReadTimeoutError(Exception):
            pass

        class PartialCredentialsError(Exception):
            pass

        assert classify_failure(APIConnectionError("down"))[0] == "request"
        assert classify_failure(NoCredentialsError())[0] == "request"
        assert classify_failure(ReadTimeoutError("slow read"))[0] == "request"
        assert classify_failure(PartialCredentialsError())[0] == "request"

    def test_auth_status_is_request_stage(self) -> None:
        # Rejected credentials (401/403) are 'request' per the stage
        # definitions, unlike other HTTP statuses.
        request = httpx.Request("POST", "https://api.test/v1/chat")
        response = httpx.Response(401, request=request)
        exc = httpx.HTTPStatusError("unauthorized", request=request, response=response)
        stage, detail = classify_failure(exc)
        assert stage == "request"
        assert "(401)" in detail

    def test_hostile_usage_property_never_breaks_usage_extraction(self) -> None:
        # usage_from_exception runs inside every LLM endpoint's exception
        # handler; a raising `usage` property must yield None, not replace
        # the original provider failure (same guard as _status_of).
        from app.api.llm_gate import usage_from_exception

        class Hostile(Exception):
            @property
            def usage(self):  # noqa: ANN201 - hostile on purpose
                raise RuntimeError("gotcha")

        assert usage_from_exception(Hostile("boom")) is None

    def test_hostile_status_property_never_breaks_classification(self) -> None:
        # "Never raises" must hold even against an exception whose
        # status_code property itself raises (getattr only swallows
        # AttributeError, not a raising property).
        class Hostile(Exception):
            @property
            def status_code(self) -> int:
                raise RuntimeError("gotcha")

        stage, detail = classify_failure(Hostile("hostile"))
        assert stage == "provider"
        assert detail == "Hostile: hostile"

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
