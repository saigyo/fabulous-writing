"""User accounts and the admin audit trail.

Authorization (tier, is_admin, is_active) lives here rather than with the
identity provider, so it survives the later switch to Supabase Auth
unchanged.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field

from app.core.auth import IAT_LEEWAY_SECONDS, check_password, hash_password
from app.services.db import Database, Row, UniqueViolationError, migrate_columns, verify_schema

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    email TEXT NOT NULL,
    display_name TEXT,
    password_hash TEXT,
    -- No CHECK on tier on purpose: tier names are policy data, defined by
    -- config.yaml's tiers: block (falling back to "basic"/"premium" when
    -- that block is absent), and SQLite cannot alter a CHECK without
    -- rebuilding the table, so a constraint here would turn "add a tier"
    -- into a migration. The API validates against the configured names
    -- instead (app/api/admin.py's _validate_tier_name), which is where
    -- invalid input actually arrives.
    tier TEXT NOT NULL DEFAULT 'basic',
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    password_changed_at TEXT,
    token_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    target_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT NOT NULL
);
-- No duplicate pre-scan before this index (unlike folders/domains/
-- profiles): email has carried UNIQUE COLLATE NOCASE since the table's
-- first version, and NOCASE ≡ LOWER() on ASCII, so no existing database
-- can hold a pair this index would reject.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (LOWER(email));
"""

# Fields update_user accepts. Anything else is a programming error, not a
# silently ignored write.
_UPDATABLE = ("display_name", "tier", "is_admin", "is_active", "external_id")

_MIGRATED_COLUMNS = [
    ("password_changed_at", "TEXT"),
    ("token_epoch", "INTEGER NOT NULL DEFAULT 0"),
]

# Tables (and post-release columns) this store needs; checked instead of
# created when the app runs without schema management (B36 spec R3).
_REQUIRED_SCHEMA = {"users": _MIGRATED_COLUMNS, "admin_audit": []}


class User(BaseModel):
    """A user as every caller sees them: no password material, ever."""

    id: int
    email: str
    display_name: str | None = None
    tier: str = "basic"
    is_admin: bool = False
    is_active: bool = True
    created_at: str
    external_id: str | None = None
    password_changed_at: str | None = None
    token_epoch: int = Field(default=0, exclude=True)


class DuplicateEmailError(ValueError):
    """An account with that email already exists (case-insensitively)."""


class InvalidEmailError(ValueError):
    """The email is empty, or whitespace-only, after stripping.

    The API models (`LoginRequest.email`, `UserCreate.email`) already reject
    this before it gets here — this is the last line of defence for callers
    that bypass those models: `seed_admin` (which does its own check),
    the operator CLI, and any future direct caller of `create_user`.
    Without it, a whitespace-only email would silently normalize to '' (see
    the stripping comment below) and become a usable, addressless account.
    """


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_user(row: Row) -> User:
    return User(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        tier=row["tier"],
        is_admin=bool(row["is_admin"]),
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        external_id=row["external_id"],
        password_changed_at=row["password_changed_at"],
        token_epoch=row["token_epoch"],
    )


class UserStore:
    def __init__(self, db: Database, *, manage_schema: bool = True) -> None:
        self.db = db
        with self._connect() as conn:
            if manage_schema:
                conn.executescript(_SCHEMA)
                self._migrate(conn)
            else:
                verify_schema(conn, _REQUIRED_SCHEMA)

    def _connect(self):
        return self.db.connect()

    def _migrate(self, conn: Any) -> None:
        """Add columns introduced after a database already existed in the
        field. A bare DDL change to `_SCHEMA` only applies via
        `CREATE TABLE IF NOT EXISTS`, which never touches an existing
        table."""
        migrate_columns(conn, "users", _MIGRATED_COLUMNS)

    def create_user(
        self,
        email: str,
        password: str | None = None,
        *,
        display_name: str | None = None,
        tier: str = "basic",
        is_admin: bool = False,
        external_id: str | None = None,
    ) -> User:
        # Strip only — do NOT lowercase: the LOWER(email) unique index and
        # the LOWER() lookups below already give case-insensitive matching,
        # and lowercasing here would throw away the case the user chose
        # before it ever reaches `User.email`. Stripping keeps this store's
        # notion of "same email" aligned with `_throttle_key`
        # (`app/api/auth.py`), which normalizes with `.strip().lower()`:
        # SQLite's LOWER() is ASCII-only casefolding, a strict subset of
        # Python's `.lower()`, so any two emails the DB treats as one row
        # already map to the same throttle key once both sides strip
        # whitespace the same way. (Databases created before B15 also
        # carry the legacy `UNIQUE COLLATE NOCASE` on the column itself —
        # same ASCII semantics, harmlessly redundant.)
        email = email.strip()
        if not email:
            # Checked before hashing the password: no reason to pay bcrypt's
            # cost for an input that is rejected outright.
            raise InvalidEmailError("email must not be empty or whitespace-only")
        password_hash = hash_password(password) if password else None
        with self._connect() as conn:
            try:
                cursor = conn.execute(
                    "INSERT INTO users"
                    " (email, display_name, password_hash, tier, is_admin, created_at,"
                    " external_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                    (
                        email,
                        display_name,
                        password_hash,
                        tier,
                        int(is_admin),
                        _utcnow(),
                        external_id,
                    ),
                )
                new_id = cursor.fetchone()["id"]
            except UniqueViolationError as exc:
                raise DuplicateEmailError(f"A user with email {email} already exists") from exc
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (new_id,)
            ).fetchone()
        return _row_to_user(row)

    def get_user(self, user_id: int) -> User | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row) if row is not None else None

    def get_by_email(self, email: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE LOWER(email) = LOWER(?)", (email.strip(),)
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    def get_by_external_id(self, external_id: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE external_id = ?", (external_id,)
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    def link_external_id(self, user_id: int, external_id: str) -> bool:
        """Atomically adopt an unlinked row for a Supabase subject.

        Used only by resolve_supabase_user's adopt-by-email path. The WHERE
        clause's `external_id IS NULL` makes this a single conditional
        UPDATE rather than the read-then-write pattern it replaces: two
        concurrent different subjects can no longer both observe the row
        unlinked and have the second write silently clobber the first,
        bypassing the collision guard. Returns False whenever the row was
        already linked (by this or another subject) by the time this
        UPDATE ran -- the caller re-reads to tell those two cases apart.

        Also returns False -- instead of letting the seam's UniqueViolationError
        propagate -- when the SUBJECT (not the target row) is already linked
        to a DIFFERENT row: the UNIQUE constraint on external_id rejects the
        UPDATE in that case. A uniqueness conflict IS a lost race, exactly
        like the target-row-already-linked case above; the caller's re-read
        already exists to resolve who owns the subject, so surfacing this as
        an unhandled 500 instead of routing through that same resolution
        would be a distinction without a difference.
        """
        with self._connect() as conn:
            try:
                cursor = conn.execute(
                    "UPDATE users SET external_id = ? WHERE id = ? AND external_id IS NULL",
                    (external_id, user_id),
                )
            except UniqueViolationError:
                return False
        return cursor.rowcount > 0

    def mark_password_changed(self, user_id: int) -> bool:
        # Supabase-mode revocation lever: the password itself lives with
        # Supabase; locally only the timestamp (checked by deps.py's
        # epoch-less fallback) and the epoch (harmless here, exact for any
        # residual local tokens) move. The recorded instant is backdated by
        # IAT_LEEWAY_SECONDS: it is compared (strict <) against iat values
        # from SUPABASE's clock, and without the allowance a trailing
        # Supabase clock would reject the fresh session minted right after
        # the change (the frontend's silent re-login). Tokens issued in the
        # final leeway window before the change stay valid here for the rest
        # of their natural TTL: the gateway's global sign-out revokes
        # REFRESH tokens only (GoTrue's `/logout?scope=global` deletes
        # sessions and refresh tokens; access tokens are stateless JWTs this
        # backend verifies locally against JWKS, so Supabase is never
        # consulted per request and cannot revoke one already issued). The
        # honest residual: an access token minted in that window keeps
        # working until it expires on its own, bounded by the Supabase
        # access-token TTL, and no new one can be minted since its refresh
        # token is already dead.
        changed_at = (
            datetime.now(UTC) - timedelta(seconds=IAT_LEEWAY_SECONDS)
        ).isoformat(timespec="seconds")
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_changed_at = ?,"
                " token_epoch = token_epoch + 1 WHERE id = ?",
                (changed_at, user_id),
            )
        return cursor.rowcount > 0

    def list_users(self) -> list[User]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM users ORDER BY LOWER(email)"
            ).fetchall()
        return [_row_to_user(row) for row in rows]

    def count(self) -> int:
        with self._connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def verify_credentials(self, email: str, password: str) -> User | None:
        """Return the user iff the password matches and the account is active.

        bcrypt runs even when no row matches (check_password falls back to a
        dummy hash), so an unknown email cannot be distinguished from a
        wrong password by response timing.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE LOWER(email) = LOWER(?)", (email.strip(),)
            ).fetchone()
        stored = row["password_hash"] if row is not None else None
        # check_password runs unconditionally — even for an unknown email
        # (row is None, stored is None) — so it always spends the same
        # bcrypt time. Do NOT add an `if row is None: return None` before
        # this call: that would skip bcrypt for unknown emails and let them
        # answer measurably faster than a known email with a wrong
        # password, reopening the account-enumeration timing oracle this
        # function exists to close.
        password_matches = check_password(password, stored)
        # `row is None` is listed first so the type checker narrows `row` to
        # non-None for the rest of this condition and for the return below;
        # check_password has already run by this point regardless of order.
        if row is None or not password_matches or not row["is_active"]:
            return None
        return _row_to_user(row)

    def set_password(self, user_id: int, password: str) -> bool:
        # token_epoch bump = exact token revocation: every outstanding token
        # carries the pre-change epoch and fails the equality check in
        # get_current_user, with no same-second window (M2's documented
        # residual with the iat comparison).
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash = ?, password_changed_at = ?,"
                " token_epoch = token_epoch + 1 WHERE id = ?",
                (hash_password(password), _utcnow(), user_id),
            )
        return cursor.rowcount > 0

    def update_user(self, user_id: int, **fields: object) -> User | None:
        unknown = set(fields) - set(_UPDATABLE)
        if unknown:
            raise ValueError(f"Not updatable: {sorted(unknown)}")
        if not fields:
            return self.get_user(user_id)
        # Column names are interpolated (not parameterised — SQLite can't
        # bind identifiers), which is safe only because the `unknown` check
        # above already rejected any name outside `_UPDATABLE`. Values stay
        # parameterised below. Do not reorder: the allowlist check must run
        # before this line.
        assignments = ", ".join(f"{name} = ?" for name in fields)
        values: list[object] = [
            int(value) if isinstance(value, bool) else value for value in fields.values()
        ]
        with self._connect() as conn:
            cursor = conn.execute(
                f"UPDATE users SET {assignments} WHERE id = ?", (*values, user_id)
            )
            if cursor.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row)

    def record_audit(
        self,
        *,
        actor_id: int | None,
        target_id: int,
        field: str,
        old_value: str | None = None,
        new_value: str | None = None,
    ) -> None:
        """One row per changed field. actor_id NULL = operator CLI (§7.5)."""
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO admin_audit"
                " (actor_id, target_id, field, old_value, new_value, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (actor_id, target_id, field, old_value, new_value, _utcnow()),
            )

    def list_audit(self) -> list[Row]:
        with self._connect() as conn:
            return conn.execute("SELECT * FROM admin_audit ORDER BY id").fetchall()
