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

        Waits until `messages_count` (Mailpit's total-match count for the
        query, not the length of the capped `messages` page) reaches
        `min_count`, then returns `messages[0]` (messages are newest first).
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            resp = httpx.get(
                f"{self._base}/api/v1/search",
                params={"query": f"to:{to}", "limit": 1},
                timeout=10,
            )
            resp.raise_for_status()
            body = resp.json()
            messages = body.get("messages", [])
            if body.get("messages_count", 0) >= min_count:
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
        Reads `messages_count`, Mailpit's total-match count for the query,
        not the length of the returned `messages` page (which is capped by
        `limit` and would silently undercount once a retained stack holds
        more than the page size) and not `total` (the whole-mailbox count,
        unfiltered by the query). limit=1 keeps the response small since
        only the count is used here."""
        resp = httpx.get(
            f"{self._base}/api/v1/search",
            params={"query": f"to:{to}", "limit": 1},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json().get("messages_count", 0)

    @staticmethod
    def extract_token(html: str) -> tuple[str, str]:
        """(token_hash, type) from the templated fragment link."""
        match = _TOKEN_RE.search(html)
        assert match, f"no token_hash fragment in mail HTML: {html[:200]}"
        return match.group(1), match.group(2)
