"""User accounts and the admin audit trail.

Authorization (tier, is_admin, is_active) lives here rather than with the
identity provider, so it survives the later switch to Supabase Auth
unchanged.
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel

from app.core.auth import check_password, hash_password
from app.services._sqlite import connect, migrate_columns

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    password_hash TEXT,
    -- No CHECK on tier on purpose: tier names are policy data that M4 moves
    -- into config.yaml, and SQLite cannot alter a CHECK without rebuilding
    -- the table, so a constraint here would turn "add a tier" into a
    -- migration. The API validates against the known names instead
    -- (app/api/admin.py), which is where invalid input actually arrives.
    tier TEXT NOT NULL DEFAULT 'basic',
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    password_changed_at TEXT
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
"""

# Fields update_user accepts. Anything else is a programming error, not a
# silently ignored write.
_UPDATABLE = ("display_name", "tier", "is_admin", "is_active", "external_id")


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


def _row_to_user(row: sqlite3.Row) -> User:
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
    )


class UserStore:
    def __init__(self, db_path: Path, *, timeout: float | None = None) -> None:
        self.db_path = db_path
        self.timeout = timeout
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    def _connect(self):
        return connect(self.db_path, timeout=self.timeout)

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Add columns introduced after a database already existed in the
        field. A bare DDL change to `_SCHEMA` only applies via
        `CREATE TABLE IF NOT EXISTS`, which never touches an existing
        table."""
        migrate_columns(conn, "users", [("password_changed_at", "TEXT")])

    def create_user(
        self,
        email: str,
        password: str | None = None,
        *,
        display_name: str | None = None,
        tier: str = "basic",
        is_admin: bool = False,
    ) -> User:
        # Strip only — do NOT lowercase. COLLATE NOCASE on the column already
        # gives case-insensitive matching; lowercasing here would throw away
        # the case the user chose before it ever reaches `User.email`.
        # Stripping keeps this store's notion of "same email" aligned with
        # `_throttle_key` (`app/api/auth.py`), which normalizes with
        # `.strip().lower()`: SQLite's NOCASE is ASCII-only casefolding, a
        # strict subset of Python's `.lower()`, so any two emails the DB
        # treats as one row already map to the same throttle key once both
        # sides strip whitespace the same way.
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
                    " (email, display_name, password_hash, tier, is_admin, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (email, display_name, password_hash, tier, int(is_admin), _utcnow()),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateEmailError(f"A user with email {email} already exists") from exc
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return _row_to_user(row)

    def get_user(self, user_id: int) -> User | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row) if row is not None else None

    def get_by_email(self, email: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email.strip(),)
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    def list_users(self) -> list[User]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM users ORDER BY email COLLATE NOCASE"
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
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email.strip(),)
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
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?",
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

    def list_audit(self) -> list[sqlite3.Row]:
        with self._connect() as conn:
            return conn.execute("SELECT * FROM admin_audit ORDER BY id").fetchall()
