"""Authentication primitives: secrets, passwords, and tokens.

The verifier indirection is what lets Supabase Auth replace local login
later without touching the request path: every implementation returns the
LOCAL users.id, so lookups never change shape.
"""

import logging
import os
import secrets
from collections.abc import Mapping
from functools import lru_cache

import bcrypt

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


SELF_MIN_PASSWORD_LENGTH = 8
ADMIN_SET_MIN_PASSWORD_LENGTH = 12


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """A real hash to verify against when no account matches.

    Computed once, lazily: without it an unknown email would skip bcrypt
    entirely and answer measurably faster than a known one, re-enabling the
    account enumeration the generic 401 is meant to prevent.
    """
    return hash_password("timing-equalisation-placeholder")


def hash_password(password: str) -> str:
    # gensalt() is the salting step: bcrypt generates a fresh random salt
    # per call and stores it inside the resulting hash string
    # ($2b$<cost>$<22-char salt><hash>), so two identical passwords never
    # produce the same hash. No separate salt column is needed — or wanted.
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, password_hash: str | None) -> bool:
    candidate = password_hash if password_hash else _dummy_hash()
    matched = bcrypt.checkpw(password.encode(), candidate.encode())
    return matched and password_hash is not None


def validate_password(password: str, *, min_length: int) -> str:
    if len(password) < min_length:
        raise ValueError(f"Password must be at least {min_length} characters")
    return password
