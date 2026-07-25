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


def _set_admin(store: UserStore, user: User, value: bool) -> None:
    store.update_user(user.id, is_admin=value)
    store.record_audit(
        actor_id=None,  # out-of-band operator action
        target_id=user.id,
        field="is_admin",
        old_value=str(user.is_admin),
        new_value=str(value),
    )


def _set_active(store: UserStore, user: User, value: bool) -> None:
    store.update_user(user.id, is_active=value)
    store.record_audit(
        actor_id=None,
        target_id=user.id,
        field="is_active",
        old_value=str(user.is_active),
        new_value=str(value),
    )


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
    _set_admin(store, user, True)
    if not user.is_active:
        _set_active(store, user, True)
    print(f"{user.email} is now an active admin")
    return 0


def _cmd_revoke_admin(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_admin(store, user, False)
    print(f"Admin privileges revoked for {user.email}")
    # Warn rather than refuse: freezing all admin access during an incident
    # and then minting a fresh account is exactly what this tool is for.
    _warn_if_no_admin_remains(store)
    return 0


def _cmd_deactivate(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_active(store, user, False)
    print(f"{user.email} deactivated; their next request will be rejected")
    _warn_if_no_admin_remains(store)
    return 0


def _cmd_activate(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_active(store, user, True)
    print(f"{user.email} reactivated")
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


def main(
    argv: list[str] | None = None, *, read_password: Callable[[str], str] | None = None
) -> int:
    # Passwords are read interactively or from stdin, never from argv: an
    # argument is visible in shell history and in `ps` to every other
    # process on the machine.
    args = _build_parser().parse_args(argv)
    args.read_password = read_password or _prompt_password
    db_path = args.db or load_settings().db_path
    store = UserStore(db_path, timeout=_BUSY_TIMEOUT_SECONDS)
    handler, _ = _COMMANDS[args.command]
    try:
        return handler(store, args)
    except sqlite3.OperationalError as exc:
        print(f"Database is busy ({exc}). Is the server writing right now?", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
