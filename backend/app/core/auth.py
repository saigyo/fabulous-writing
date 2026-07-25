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
MAX_PASSWORD_BYTES = 72  # bcrypt's hard input limit, not a policy choice


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """A real hash to verify against when no account matches.

    Computed once, lazily: without it an unknown email would skip bcrypt
    entirely and answer measurably faster than a known one, re-enabling the
    account enumeration the generic 401 is meant to prevent.
    """
    return hash_password("timing-equalisation-placeholder")


def hash_password(password: str) -> str:
    """Hash a password with bcrypt.

    Write path: must fail loudly on over-long input. Every caller
    (admin API, self-service change, bootstrap, operator CLI) validates first;
    truncating here would silently weaken a credential.
    """
    # gensalt() is the salting step: bcrypt generates a fresh random salt
    # per call and stores it inside the resulting hash string
    # ($2b$<cost>$<22-char salt><hash>), so two identical passwords never
    # produce the same hash. No separate salt column is needed — or wanted.
    encoded = password.encode()
    if len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError(
            f"Password is too long ({len(encoded)} bytes, max {MAX_PASSWORD_BYTES}). "
            f"Call validate_password() before hashing."
        )
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode()


def check_password(password: str, password_hash: str | None) -> bool:
    """Verify a password candidate against a stored hash.

    Read path with untrusted input: must never raise and must never leak
    timing. Truncates over-long candidates to prevent bcrypt ValueError,
    but returns False unconditionally for any over-long candidate because
    no over-long password can ever have been stored after hash_password
    started rejecting them.
    """
    # Treat both None and empty string as "no hash stored".
    if not password_hash:
        candidate = _dummy_hash()
    else:
        candidate = password_hash

    # Encode and check length.
    encoded = password.encode()
    if len(encoded) > MAX_PASSWORD_BYTES:
        # Truncate to prevent ValueError from bcrypt, but spend the bcrypt time
        # to avoid timing leaks. Return False unconditionally: an over-long
        # candidate cannot match any stored hash.
        bcrypt.checkpw(encoded[:MAX_PASSWORD_BYTES], candidate.encode())
        return False

    matched = bcrypt.checkpw(encoded, candidate.encode())
    # Return True only if match succeeds AND a real hash was present.
    return matched and bool(password_hash)


def validate_password(password: str, *, min_length: int) -> str:
    # Minimum is counted in characters (policy constraint); maximum in bytes
    # (bcrypt's technical limit).
    if len(password) < min_length:
        raise ValueError(f"Password must be at least {min_length} characters")
    if len(password.encode()) > MAX_PASSWORD_BYTES:
        raise ValueError(f"Password must be at most {MAX_PASSWORD_BYTES} bytes")
    return password
