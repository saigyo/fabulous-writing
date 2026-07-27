"""Global request-size cap (spec §6.5): a byte budget derived from the char
cap, enforced before parsing and on the bytes actually read — so chunked
requests without a Content-Length cannot bypass it."""

from fastapi import HTTPException


def byte_budget(max_document_chars: int) -> int:
    """max(5 MB, 4 × chars + 1 MB): UTF-8 worst case plus JSON overhead, so
    raising max_document_chars can never strand legal payloads behind a
    stale fixed byte limit (spec §6.5)."""
    return max(5 * 1024 * 1024, 4 * max_document_chars + 1024 * 1024)


class RequestSizeLimitMiddleware:
    """Pure ASGI on purpose: BaseHTTPMiddleware's response buffering would
    fight the SSE stream. Rejects on Content-Length before reading anything,
    and counts the bytes actually received for chunked bodies.

    Deliberate scope: the chunked-body cap meters bytes the application
    actually reads. A handler that never reads its body allocates nothing, so
    an oversized chunked body sent to a bodyless endpoint is answered
    normally rather than 413'd -- draining/metering it before dispatch would
    require exactly the buffering this middleware exists to avoid."""
    def __init__(self, app, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > self.max_bytes:
                    await _send_413(send)
                    return
            except ValueError:
                pass
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    # Raised as an HTTPException, not a bespoke exception: a
                    # bespoke exception raised here (mid-body-read, so deep
                    # inside FastAPI's own request-parsing call) gets caught
                    # by FastAPI's generic body-parsing except-clause and
                    # turned into its own 400 "There was an error parsing the
                    # body" -- FastAPI special-cases HTTPException and
                    # re-raises it untouched instead, so this is the shape
                    # that reaches Starlette's ExceptionMiddleware (and, one
                    # layer further out, CORS) as a real, CORS-visible 413.
                    raise HTTPException(413, "Request body too large")
            return message

        await self.app(scope, limited_receive, send)


async def _send_413(send) -> None:
    body = b'{"detail":"Request body too large"}'
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})
