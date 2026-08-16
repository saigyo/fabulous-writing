"""Minimal Mailpit REST client (API shapes verified on the CLI 2.114.0 stack)."""

import re
import time

import httpx

_TOKEN_RE = re.compile(r'#token_hash=([^&"]+)&type=(\w+)')


class Mailpit:
    def __init__(self, base_url: str) -> None:
        self._base = base_url.rstrip("/")

    def wait_for_message(
        self, to: str, timeout: float = 20.0, min_count: int = 1
    ) -> dict:
        """Newest message addressed to `to`, polled every 0.5 s.

        Waits until at least `min_count` messages have arrived (messages are
        newest first) before returning the newest one.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            resp = httpx.get(
                f"{self._base}/api/v1/search",
                params={"query": f"to:{to}", "limit": 200},
                timeout=10,
            )
            resp.raise_for_status()
            messages = resp.json().get("messages", [])
            if len(messages) >= min_count:
                msg_id = messages[0]["ID"]
                detail = httpx.get(
                    f"{self._base}/api/v1/message/{msg_id}", timeout=10
                )
                detail.raise_for_status()
                return detail.json()
            time.sleep(0.5)
        raise AssertionError(
            f"no mail for {to!r} within {timeout}s — note GoTrue's default"
            " email rate limit (30 mails/hour, not configurable on the"
            " Mailpit-backed local stack) can also cause this: run"
            " scripts/e2e-supabase.sh --down and restart the stack"
        )

    def count_messages(self, to: str) -> int:
        """Current number of messages addressed to `to` -- the absence
        half of an assertion pair: capture before, compare after a
        deterministic bound (a later mail's arrival) has passed.
        limit=200 keeps the page size above anything a test run can
        accumulate (Mailpit's default page is 50 -- len() over a capped
        page would silently undercount)."""
        resp = httpx.get(
            f"{self._base}/api/v1/search",
            params={"query": f"to:{to}", "limit": 200},
            timeout=10,
        )
        resp.raise_for_status()
        return len(resp.json().get("messages", []))

    @staticmethod
    def extract_token(html: str) -> tuple[str, str]:
        """(token_hash, type) from the templated fragment link."""
        match = _TOKEN_RE.search(html)
        assert match, f"no token_hash fragment in mail HTML: {html[:200]}"
        return match.group(1), match.group(2)
