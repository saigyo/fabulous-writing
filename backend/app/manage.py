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

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.core.config import load_settings
from app.services.users import User, UserStore

# Long enough to wait out a running server's write, short enough to fail
# rather than hang. Each command performs a single write, so there is no
# read-modify-write transaction to deadlock on.
_BUSY_TIMEOUT_SECONDS = 10.0


def _prompt_password(prompt: str) -> str:
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    return sys.stdin.readline().rstrip("\n")


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


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.manage")
    parser.add_argument("--db", type=Path, default=None, help="database path")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, (_handler, needs_email) in _COMMANDS.items():
        sub = subparsers.add_parser(name)
        if needs_email:
            sub.add_argument("email")
    return parser


def _parse_args(parser: argparse.ArgumentParser, argv: list[str] | None) -> argparse.Namespace:
    # parse_known_args (not parse_args) so a stray extra token — most
    # plausibly a mistyped password after `set-password <email>` — can be
    # rejected without letting argparse format it into its own "unrecognized
    # arguments: <token>" message. That message goes to stderr, which is
    # routinely logged or `tee`d for an audit trail, so echoing it back
    # would leak the very password argv is not supposed to carry. Every
    # other parse failure (unknown subcommand, missing email, unknown
    # option) is raised by parse_known_args itself, before this point, with
    # argparse's normal — and safe — messages intact.
    args, extras = parser.parse_known_args(argv)
    if extras:
        print(parser.format_usage(), end="", file=sys.stderr)
        print(
            f"{parser.prog}: error: unrecognized arguments (value withheld: "
            "passwords are never accepted as command-line arguments — they "
            "are prompted for or read from stdin)",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return args


def main(
    argv: list[str] | None = None, *, read_password: Callable[[str], str] | None = None
) -> int:
    # Passwords are read interactively or from stdin, never from argv: an
    # argument is visible in shell history and in `ps` to every other
    # process on the machine.
    args = _parse_args(_build_parser(), argv)
    args.read_password = read_password or _prompt_password
    db_path = args.db or load_settings().db_path
    try:
        # UserStore.__init__ writes the schema on every invocation, so the
        # busy/corrupt guard must cover construction too, not just the
        # command handler below — a database locked by a running server (or
        # an unreadable/corrupt file) is exactly as likely to be hit here.
        store = UserStore(db_path, timeout=_BUSY_TIMEOUT_SECONDS)
        handler, _ = _COMMANDS[args.command]
        return handler(store, args)
    except sqlite3.OperationalError as exc:
        print(f"Database is busy ({exc}). Is the server writing right now?", file=sys.stderr)
        return 1
    except sqlite3.DatabaseError as exc:
        # OperationalError (busy) is a subclass of DatabaseError, so this
        # broader clause must come second or it would shadow the message
        # above for the busy case. Whatever is left over here is a
        # different operator situation — a corrupt or unreadable file —
        # calling for a different next step (restore from backup, not wait).
        print(f"Database is unreadable or corrupt ({exc}).", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
