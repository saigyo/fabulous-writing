"""Authentication primitives: secrets, passwords, and tokens.

The verifier indirection is what lets Supabase Auth replace local login
later without touching the request path: every implementation returns the
LOCAL users.id, so lookups never change shape.
"""

import logging
import os
import secrets
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Protocol

import bcrypt
import jwt

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

_BCRYPT_ROUNDS = 12  # bcrypt's library default, kept explicit so the test
# suite can lower it (tests/conftest.py); deliberately not a Settings knob.


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
    return bcrypt.hashpw(encoded, bcrypt.gensalt(_BCRYPT_ROUNDS)).decode()


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
    try:
        if len(encoded) > MAX_PASSWORD_BYTES:
            # Truncate to prevent ValueError from bcrypt, but spend the bcrypt time
            # to avoid timing leaks. Return False unconditionally: an over-long
            # candidate cannot match any stored hash.
            bcrypt.checkpw(encoded[:MAX_PASSWORD_BYTES], candidate.encode())
            return False

        matched = bcrypt.checkpw(encoded, candidate.encode())
        # Return True only if match succeeds AND a real hash was present.
        return matched and bool(password_hash)
    except ValueError:
        # bcrypt.checkpw raises ValueError on a non-empty but malformed
        # stored hash (bad prefix, wrong length, invalid salt). Unreachable
        # today, since hash_password() is the only writer and "" / None are
        # already handled above, but a Supabase-era migration or a
        # hand-edited row could introduce one — treat it as "does not
        # match" rather than letting it 500 the login path.
        return False


def validate_password(password: str, *, min_length: int) -> str:
    # Minimum is counted in characters (policy constraint); maximum in bytes
    # (bcrypt's technical limit).
    if len(password) < min_length:
        raise ValueError(f"Password must be at least {min_length} characters")
    if len(password.encode()) > MAX_PASSWORD_BYTES:
        raise ValueError(f"Password must be at most {MAX_PASSWORD_BYTES} bytes")
    return password


TOKEN_ISSUER = "fabulous-writing"
TOKEN_AUDIENCE = "fabulous-writing"
TOKEN_TTL = timedelta(hours=24)
# Tolerated clock drift between this server and the token issuer. Without
# it, a slightly fast issuer (notably Supabase's signing service later)
# would cause intermittent 401s.
IAT_LEEWAY_SECONDS = 60


class InvalidToken(Exception):
    """The token is absent, malformed, expired, or not ours."""


@dataclass(frozen=True)
class VerifiedToken:
    """The result of a successful verify(): who, and when the token was
    minted.

    `issued_at` crosses this boundary — rather than staying an internal
    detail of the verifier — because the request path, not the verifier,
    owns revocation policy: `get_current_user` primarily compares `epoch`
    against `users.token_epoch` (exact equality); `issued_at` vs.
    `users.password_changed_at` is only the fallback for an epoch-less
    verifier (a future Supabase verifier has no notion of `epoch` at all).
    """

    user_id: int          # always the LOCAL users.id, in every auth mode
    issued_at: datetime   # tz-aware UTC
    epoch: int | None    # per-user token epoch; None = this verifier has no
                         # epoch concept (the future Supabase verifier), in
                         # which case get_current_user falls back to the
                         # password_changed_at comparison.


class TokenVerifier(Protocol):
    def verify(self, token: str) -> VerifiedToken:
        """Return the LOCAL users.id and the token's issue time, or raise
        InvalidToken.

        Every implementation returns a local id — the Supabase verifier
        will resolve its subject UUID to users.external_id internally and
        fail closed when unlinked — so the request path never changes
        lookup keys between auth modes.
        """
        ...


def issue_token(
    user_id: int, secret: str, *, epoch: int, now: datetime | None = None
) -> str:
    issued = now or datetime.now(UTC)
    return jwt.encode(
        {
            "sub": str(user_id),
            "iat": int(issued.timestamp()),
            "exp": int((issued + TOKEN_TTL).timestamp()),
            "iss": TOKEN_ISSUER,
            "aud": TOKEN_AUDIENCE,
            "epoch": epoch,
        },
        secret,
        algorithm="HS256",
    )


class LocalTokenVerifier:
    """Verifies tokens this backend issued (auth.mode: local)."""

    def __init__(self, secret: str) -> None:
        self._secret = secret

    def verify(self, token: str) -> VerifiedToken:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],  # exactly one: never 'none', never asymmetric
                issuer=TOKEN_ISSUER,
                audience=TOKEN_AUDIENCE,
                options={
                    "require": ["sub", "exp", "iat", "iss", "aud", "epoch"],
                    # PyJWT >= 2.10 validates iat itself with 0 leeway,
                    # which would reject the tolerated clock drift below
                    # before this method ever saw the claims. Disabled so
                    # the explicit leeway check is the only iat check.
                    "verify_iat": False,
                },
            )
        except (jwt.PyJWTError, RecursionError) as exc:
            # RecursionError (a RuntimeError, not a PyJWTError) comes from
            # json.loads on a deeply nested header segment, which PyJWT must
            # parse to read `alg` before checking the signature. Caught here
            # rather than only capping length in deps.py, since the depth that
            # trips it depends on the interpreter's recursion limit. Kept
            # narrow so a real TypeError still surfaces as a 500.
            raise InvalidToken(str(exc)) from exc
        # iat is checked here rather than left to the library so the leeway
        # is explicit and does not depend on PyJWT's version-specific
        # treatment of future issue times. Disabling verify_iat above also
        # disabled PyJWT's own int(...) type-check on iat, so a malformed
        # claim (list, dict, non-numeric string) must be caught here too,
        # not just a bad drift value.
        # Parsed once and converted inside the same guard that used to just
        # call float(): fromtimestamp() rejects a numeric *string* that
        # float() accepts, and an out-of-range value raises OverflowError
        # (OSError on some platforms), neither of which was in the original
        # tuple. Letting either escape here is exactly the M1 leak (a
        # crafted iat becoming a raw 500 on the auth path) this guard exists
        # to prevent.
        try:
            issued_at = datetime.fromtimestamp(float(claims["iat"]), UTC)
        except (TypeError, ValueError, OverflowError, OSError) as exc:
            raise InvalidToken("iat is not a usable timestamp") from exc
        drift = issued_at.timestamp() - datetime.now(UTC).timestamp()
        if drift > IAT_LEEWAY_SECONDS:
            raise InvalidToken("token issued too far in the future")
        try:
            user_id = int(claims["sub"])
        except (TypeError, ValueError) as exc:
            raise InvalidToken("sub is not a user id") from exc
        raw_epoch = claims["epoch"]
        # bool is an int subclass; True would silently pass an isinstance
        # check and compare equal to epoch 1.
        if isinstance(raw_epoch, bool) or not isinstance(raw_epoch, int):
            raise InvalidToken("epoch is not an integer")
        return VerifiedToken(user_id=user_id, issued_at=issued_at, epoch=raw_epoch)
