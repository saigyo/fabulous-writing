"""Operator CLI: `uv run python -m app.manage <command>`.

Recovery and incident response that must not depend on a working web
session — a forgotten admin password, or an admin account being misused.
It requires shell access to the machine, which already implies control of
the database, so it adds no attack surface; the alternatives (an env-var
password reset, or a recovery endpoint) would each leave a standing hole.
"""

import argparse
import getpass
import sqlite3
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NoReturn

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.core.config import Settings, load_settings
from app.services.db import create_database
from app.services.users import User, UserStore

# Long enough to wait out a running server's write, short enough to fail
# rather than hang. Each command performs a single write, so there is no
# read-modify-write transaction to deadlock on.
_BUSY_TIMEOUT_SECONDS = 10.0


def _prompt_password(prompt: str) -> str:
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    # `.rstrip("\r\n")`, not a bare `.rstrip()`: a trailing space can be a
    # legitimate password character and must survive. This strips only the
    # line ending readline() leaves behind — including the `\r` a
    # CRLF-terminated stream (a file piped in from Windows, or any
    # `\r\n`-terminated input) would otherwise leave stuck to the end of
    # the password, which then fails validation or authentication with no
    # visible reason why — a miserable failure mode for a recovery tool.
    return sys.stdin.readline().rstrip("\r\n")


def _is_lock_contention(exc: sqlite3.OperationalError) -> bool:
    """Is this OperationalError SQLite's own wording for a held lock?

    sqlite3 does not give lock contention its own exception type: every
    OperationalError shares this one class, from "database is locked" to
    "no such column: <typo>". Message-sniffing is the only way to tell
    them apart, which is a smell — but the alternative (treating every
    OperationalError from a handler as "busy") mislabels a real bug as
    database trouble and swallows its traceback.

    "database is locked" is SQLite's real SQLITE_BUSY message — confirmed
    by `strings` against the libsqlite3 this build actually links, not
    assumed. Deadlock ("database is deadlocked", from `BEGIN CONCURRENT`)
    is deliberately not matched: this build's SQLite does not contain that
    string at all (grepped for and absent), and UserStore never issues
    `BEGIN CONCURRENT`, so the case cannot arise here. An unmatched
    deadlock would fall through to the generic re-raise below and surface
    as a traceback — a safe default, not a silent misdiagnosis — rather
    than as a wrong "busy" message.
    """
    return "database is locked" in str(exc).lower()


def _find(store: UserStore, email: str) -> User | None:
    user = store.get_by_email(email)
    if user is None:
        print(f"User not found: {email}", file=sys.stderr)
    return user


def _set_admin(store: UserStore, user: User, value: bool) -> bool:
    """Set is_admin, returning whether anything actually changed.

    A no-op write would still look like a state transition in the audit
    trail (old_value == new_value), which is actively misleading during an
    incident — the trail is the thing being read. Mirrors how the admin API
    (app/api/admin.py) already filters no-ops before writing.
    """
    if user.is_admin == value:
        return False
    store.update_user(user.id, is_admin=value)
    store.record_audit(
        actor_id=None,  # out-of-band operator action
        target_id=user.id,
        field="is_admin",
        old_value=str(user.is_admin),
        new_value=str(value),
    )
    return True


def _set_active(store: UserStore, user: User, value: bool) -> bool:
    """Set is_active, returning whether anything actually changed."""
    if user.is_active == value:
        return False
    store.update_user(user.id, is_active=value)
    store.record_audit(
        actor_id=None,
        target_id=user.id,
        field="is_active",
        old_value=str(user.is_active),
        new_value=str(value),
    )
    return True


def _warn_if_no_admin_remains(store: UserStore) -> None:
    if any(user.is_admin and user.is_active for user in store.list_users()):
        return
    print(
        "Warning: no admin account is active anymore. Restore one with "
        "`python -m app.manage make-admin <email>`.",
        file=sys.stderr,
    )


def _cmd_list_users(store: UserStore, _args: argparse.Namespace) -> int:
    for user in store.list_users():
        flags = ", ".join(
            [*(["admin"] if user.is_admin else []), *([] if user.is_active else ["inactive"])]
        )
        print(f"{user.id}\t{user.email}\t{user.tier}\t{flags}")
    return 0


def _cmd_set_password(store: UserStore, args: argparse.Namespace) -> int:
    if load_settings().auth.mode != "local":
        print(
            "Refusing: auth.mode is 'supabase', where passwords live in "
            "Supabase and this hash would never be read. Use Supabase's own "
            "password reset flow.",
            file=sys.stderr,
        )
        return 1
    user = _find(store, args.email)
    if user is None:
        return 1
    password = args.read_password(f"New password for {user.email}: ")
    try:
        validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    store.set_password(user.id, password)
    store.record_audit(actor_id=None, target_id=user.id, field="password")
    print(f"Password updated for {user.email}")
    return 0


def _cmd_make_admin(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    admin_changed = _set_admin(store, user, True)
    active_changed = _set_active(store, user, True)
    if admin_changed or active_changed:
        print(f"{user.email} is now an active admin")
    else:
        print(f"{user.email} is already an active admin; no change made")
    return 0


def _cmd_revoke_admin(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    if _set_admin(store, user, False):
        print(f"Admin privileges revoked for {user.email}")
    else:
        print(f"{user.email} was already not an admin; no change made")
    # Warn rather than refuse: freezing all admin access during an incident
    # and then minting a fresh account is exactly what this tool is for.
    _warn_if_no_admin_remains(store)
    return 0


def _cmd_deactivate(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    if _set_active(store, user, False):
        print(f"{user.email} deactivated; their next request will be rejected")
    else:
        print(f"{user.email} was already inactive; no change made")
    _warn_if_no_admin_remains(store)
    return 0


def _cmd_activate(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    if _set_active(store, user, True):
        print(f"{user.email} reactivated")
    else:
        print(f"{user.email} was already active; no change made")
    return 0


_COMMANDS = {
    "list-users": (_cmd_list_users, False),
    "set-password": (_cmd_set_password, True),
    "make-admin": (_cmd_make_admin, True),
    "revoke-admin": (_cmd_revoke_admin, True),
    "deactivate": (_cmd_deactivate, True),
    "activate": (_cmd_activate, True),
}


class _SilentArgumentParser(argparse.ArgumentParser):
    """An ArgumentParser whose error() never echoes the offending token.

    argparse's default error() interpolates the bad value straight into its
    message — "invalid choice: '<token>'", "the following arguments are
    required: email", "unrecognized arguments: <token>" — and for an
    invalid choice or a missing required argument it does so from deep
    inside parse_known_args, before any of our own code gets a chance to
    look at what was typed. If that token were ever a mistyped password,
    the message would put it on stderr, which is routinely logged or
    `tee`d. So every parse failure this method is responsible for collapses
    to one generic message: the usage line, the list of valid commands, and
    a note that values are withheld. This is deliberately uniform rather
    than case-specific — an operator who typo'd a subcommand still gets the
    actionable part (the valid-command list) and no input is ever echoed,
    in exchange for a somewhat generic message on, say, a missing `email`.

    `add_subparsers()` defaults `parser_class` to `type(self)`, so every
    subparser built from a `_SilentArgumentParser` inherits this override
    too — a missing `email` on the `set-password` subparser goes through
    the same generic path as an unknown top-level subcommand.
    """

    def error(self, message: str) -> NoReturn:  # noqa: ARG002 - message deliberately unused
        self.print_usage(sys.stderr)
        print(
            f"{self.prog}: error: invalid arguments. Valid commands: "
            f"{', '.join(_COMMANDS)}. Values are withheld: passwords are "
            "never accepted as command-line arguments — they are prompted "
            "for or read from stdin.",
            file=sys.stderr,
        )
        raise SystemExit(2)


def _build_parser() -> argparse.ArgumentParser:
    parser = _SilentArgumentParser(prog="python -m app.manage")
    parser.add_argument(
        "--db", type=Path, default=None, help="database path (sqlite mode only)"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, (_handler, needs_email) in _COMMANDS.items():
        sub = subparsers.add_parser(name)
        if needs_email:
            sub.add_argument("email")
    return parser


def _parse_args(parser: argparse.ArgumentParser, argv: list[str] | None) -> argparse.Namespace:
    # parse_known_args (not parse_args) so a stray extra token — most
    # plausibly a mistyped password after `set-password <email>`, or an
    # unrecognised option — is caught here rather than by argparse's own
    # "unrecognized arguments: <token>" message. Routed through the same
    # parser.error() override as every other parse failure (see
    # _SilentArgumentParser above), so this path and the invalid-choice /
    # missing-argument paths never disagree about what gets echoed.
    args, extras = parser.parse_known_args(argv)
    if extras:
        parser.error("unrecognized arguments")
    return args


def main(
    argv: list[str] | None = None, *, read_password: Callable[[str], str] | None = None
) -> int:
    # Passwords are read interactively or from stdin, never from argv: an
    # argument is visible in shell history and in `ps` to every other
    # process on the machine.
    args = _parse_args(_build_parser(), argv)
    args.read_password = read_password or _prompt_password
    if args.db is not None:
        # --db pins a SQLite file directly and must work without a
        # loadable config (operator escape hatch); backend defaults
        # to sqlite in a bare Settings.
        try:
            # Best-effort warning only: load_settings() failing is exactly
            # when this escape hatch is needed most (a broken config), so
            # any failure here is swallowed and --db proceeds silently.
            configured = load_settings()
        except Exception:
            configured = None
        if configured is not None and configured.database.backend == "postgres":
            print(
                "config selects the postgres backend; --db overrides it with a "
                "SQLite file",
                file=sys.stderr,
            )
        settings = Settings(db_path=args.db)
    else:
        settings = load_settings()

    # UserStore.__init__ writes the schema on every invocation, so this is
    # the one place a locked, corrupt, or unopenable database can surface
    # before any command-specific logic runs at all. "Unopenable" is its
    # own case, not folded into "busy": OperationalError also covers
    # "unable to open database file" — --db pointed at a directory, a
    # read-only file, or a parent directory that couldn't be created — none
    # of which is lock contention, and mislabeling it "busy" would send an
    # operator to wait out a lock that does not exist. Reuses
    # _is_lock_contention (defined above for the same discrimination on the
    # handler path below) to tell the two apart. A postgres connection
    # failure escapes these handlers entirely and surfaces as its own
    # error — fail loudly, the spec's intent for that backend.
    # Built outside the try/finally below so a failure here (before there is
    # anything to close) doesn't run close() against a name that was never
    # bound; everything from here on — store construction, command dispatch,
    # any sys.exit a handler raises (SystemExit still runs a finally) — must
    # release the pool/connection on its way out, in-process callers of
    # main() (tests, the postgres backend's pool and worker threads) have no
    # other place that would do it for them.
    database = create_database(settings, timeout=_BUSY_TIMEOUT_SECONDS)
    try:
        try:
            store = UserStore(database)
        except sqlite3.OperationalError as exc:
            if _is_lock_contention(exc):
                print(f"Database is busy ({exc}). Is the server writing right now?", file=sys.stderr)
            else:
                print(
                    f"Could not open the database at {settings.db_path} ({exc}). Check "
                    "the path and its permissions.",
                    file=sys.stderr,
                )
            return 1
        except sqlite3.DatabaseError as exc:
            # OperationalError (busy) is itself a DatabaseError subclass, so
            # this broader clause must come second or it would shadow the
            # message above for the busy case. Whatever is left over here is a
            # different operator situation — a corrupt or unreadable file —
            # calling for a different next step (restore from backup, not wait).
            print(f"Database is unreadable or corrupt ({exc}).", file=sys.stderr)
            return 1

        handler, _ = _COMMANDS[args.command]
        try:
            return handler(store, args)
        except sqlite3.OperationalError as exc:
            # Handlers perform real writes (set_password, update_user), so lock
            # contention hit here deserves the same clean message as at
            # startup — but only lock contention. Re-raise anything else
            # unchanged: a non-lock OperationalError is a bug (see
            # _is_lock_contention), and mislabeling it as "the database is
            # busy" would send an operator to wait out a lock that does not
            # exist, during exactly the incident this tool is for.
            if not _is_lock_contention(exc):
                raise
            print(f"Database is busy ({exc}). Is the server writing right now?", file=sys.stderr)
            return 1
    finally:
        database.close()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
