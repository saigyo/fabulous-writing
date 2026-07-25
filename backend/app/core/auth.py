"""Authentication primitives: secrets, passwords, and tokens.

The verifier indirection is what lets Supabase Auth replace local login
later without touching the request path: every implementation returns the
LOCAL users.id, so lookups never change shape.
"""

import logging
import os
import secrets
from collections.abc import Mapping

logger = logging.getLogger(__name__)

MIN_SECRET_LENGTH = 32


class AuthConfigError(RuntimeError):
    """Authentication cannot be configured safely; startup must not continue."""


def resolve_auth_secret(
    *, ephemeral_ok: bool, env: Mapping[str, str] | None = None
) -> str:
    """Return the HS256 signing secret (local mode only).

    Length is the mechanical gate; the requirement that the value be
    randomly generated (`openssl rand -base64 32`) is documented in
    config.example.yaml and the README, since entropy cannot be checked.
    """
    environ = os.environ if env is None else env
    raw = environ.get("FW_AUTH_SECRET", "")
    if raw:
        if len(raw) < MIN_SECRET_LENGTH:
            raise AuthConfigError(
                f"FW_AUTH_SECRET must be at least {MIN_SECRET_LENGTH} characters"
            )
        return raw
    if ephemeral_ok:
        # States the fact, never the value: a secret in a log file is a
        # credential at rest.
        logger.warning(
            "FW_AUTH_SECRET is unset; using an ephemeral secret. Every token "
            "becomes invalid on restart. Never do this outside development."
        )
        return secrets.token_urlsafe(48)
    raise AuthConfigError(
        "FW_AUTH_SECRET is unset. Generate one with `openssl rand -base64 32`, "
        "or set auth.ephemeral_secret: true for local development."
    )
