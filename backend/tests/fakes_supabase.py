"""Shared supabase-mode test doubles: static JWKS + fake gateway (Task 4)."""

import jwt


class StaticJWKSClient:
    """Duck-types PyJWKClient.get_signing_key_from_jwt for a fixed key set.

    Keys: mapping kid -> public-key object. Unknown kid raises
    PyJWKClientError exactly like the real client after a failed refetch.
    """

    def __init__(self, keys):
        self.keys = keys
        self.calls = 0

    def get_signing_key_from_jwt(self, token: str):
        self.calls += 1
        kid = jwt.get_unverified_header(token).get("kid")
        if kid not in self.keys:
            raise jwt.exceptions.PyJWKClientError(f"Unable to find kid {kid!r}")

        class _Key:
            def __init__(self, key):
                self.key = key

        return _Key(self.keys[kid])
