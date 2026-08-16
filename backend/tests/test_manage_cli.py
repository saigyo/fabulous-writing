import io
import sqlite3
from pathlib import Path

import pytest

from app.core.config import Settings
from app.manage import main
from app.services.db.sqlite import SqliteDatabase
from app.services.users import UserStore


@pytest.fixture()
def db(tmp_path: Path) -> Path:  # intentionally shadows conftest's parametrized `db`: this module is SQLite/CLI-scoped by design
    path = tmp_path / "test.db"
    store = UserStore(SqliteDatabase(path))
    store.create_user("root@example.com", "bootstrap password", is_admin=True)
    store.create_user("ada@example.com", "an initial password")
    return path


def run(db: Path, *args: str, password: str | None = None) -> int:
    return main(
        ["--db", str(db), *args],
        read_password=(lambda _prompt: password) if password else None,
    )


def test_list_users(db, capsys):
    assert run(db, "list-users") == 0
    output = capsys.readouterr().out
    assert "root@example.com" in output and "ada@example.com" in output
    assert "admin" in output.lower()


def test_set_password_lets_the_account_log_in_again(db):
    assert run(db, "set-password", "ada@example.com", password="a recovered password") == 0
    store = UserStore(SqliteDatabase(db))
    assert store.verify_credentials("ada@example.com", "a recovered password") is not None


def test_set_password_strips_a_crlf_line_ending_from_a_piped_password(db, monkeypatch):
    # A password piped in from a CRLF-terminated stream — a file written on
    # Windows, or any \r\n-terminated input — must not carry a trailing \r
    # into the stored password. Left in, it fails validation or
    # authentication with no visible reason why: a miserable failure mode
    # for a tool used mid-incident. Trailing spaces, in contrast, must
    # survive: only \r and \n are stripped, not "whitespace" generally.
    monkeypatch.setattr("sys.stdin", io.StringIO("a recovered password\r\n"))
    assert main(["--db", str(db), "set-password", "ada@example.com"]) == 0
    store = UserStore(SqliteDatabase(db))
    assert store.verify_credentials("ada@example.com", "a recovered password") is not None
    assert store.verify_credentials("ada@example.com", "a recovered password\r") is None


# A password in argv lands in shell history and in `ps` output for every
# other process on the machine regardless of what the CLI does. What the CLI
# controls is whether it *also* lands in stderr/stdout — which is routinely
# logged or `tee`d for an audit trail — via one of argparse's own error
# messages, which by default interpolate the offending token directly (e.g.
# "invalid choice: '<token>'", "unrecognized arguments: <token>").
_LEAKY_PASSWORD = "hunter2hunter2"


@pytest.mark.parametrize(
    "argv_suffix",
    [
        pytest.param([_LEAKY_PASSWORD], id="unknown-subcommand"),
        pytest.param(
            [_LEAKY_PASSWORD, "set-password", "ada@example.com"], id="token-before-subcommand"
        ),
        pytest.param(["set-password"], id="missing-required-email"),
        pytest.param(
            ["set-password", "ada@example.com", _LEAKY_PASSWORD],
            id="extra-positional-after-email",
        ),
        pytest.param(
            ["--bogus", _LEAKY_PASSWORD, "list-users"],
            id="unknown-option-space-form-before-subcommand",
        ),
        pytest.param(
            [f"--bogus={_LEAKY_PASSWORD}", "list-users"],
            id="unknown-option-equals-form-before-subcommand",
        ),
        pytest.param(
            ["set-password", "ada@example.com", "--bogus", _LEAKY_PASSWORD],
            id="unknown-option-space-form-after-subcommand",
        ),
        pytest.param(
            ["set-password", "ada@example.com", f"--bogus={_LEAKY_PASSWORD}"],
            id="unknown-option-equals-form-after-subcommand",
        ),
    ],
)
def test_no_argv_shape_ever_echoes_a_password_onto_stderr_or_stdout(db, capsys, argv_suffix):
    with pytest.raises(SystemExit):
        main(["--db", str(db), *argv_suffix])
    captured = capsys.readouterr()
    assert _LEAKY_PASSWORD not in captured.err
    assert _LEAKY_PASSWORD not in captured.out


def test_set_password_enforces_the_admin_minimum(db, capsys):
    assert run(db, "set-password", "ada@example.com", password="short") == 1
    assert "at least 12" in capsys.readouterr().err


def test_set_password_refuses_in_supabase_mode(db, tmp_path, capsys, monkeypatch):
    # Writing a hash nothing reads would look successful while changing
    # nothing — and would become a live credential if the mode were ever
    # switched back to local.
    monkeypatch.setattr(
        "app.manage.load_settings",
        lambda: Settings(db_path=db, auth={"mode": "supabase"}),
    )
    assert run(db, "set-password", "ada@example.com", password="a recovered password") == 1
    assert "supabase" in capsys.readouterr().err.lower()
    assert (
        UserStore(SqliteDatabase(db)).verify_credentials(
            "ada@example.com", "an initial password"
        )
        is not None
    )


def test_make_admin_grants_and_reactivates(db):
    store = UserStore(SqliteDatabase(db))
    store.update_user(2, is_active=False)
    assert run(db, "make-admin", "ada@example.com") == 0
    user = store.get_user(2)
    assert user.is_admin is True and user.is_active is True


def test_revoke_admin_warns_but_proceeds_when_no_admin_remains(db, capsys):
    assert run(db, "revoke-admin", "root@example.com") == 0
    assert UserStore(SqliteDatabase(db)).get_user(1).is_admin is False
    # It must not refuse: freezing all admin access and then minting a fresh
    # one with make-admin is a legitimate incident response.
    assert "no admin" in capsys.readouterr().err.lower()


def test_deactivate_and_activate(db):
    store = UserStore(SqliteDatabase(db))
    assert run(db, "deactivate", "ada@example.com") == 0
    assert store.get_user(2).is_active is False
    assert run(db, "activate", "ada@example.com") == 0
    assert store.get_user(2).is_active is True


def test_unknown_email_is_an_error(db, capsys):
    assert run(db, "make-admin", "nobody@example.com") == 1
    assert "not found" in capsys.readouterr().err.lower()


def test_every_mutation_is_audited_as_an_out_of_band_action(db):
    run(db, "make-admin", "ada@example.com")
    rows = UserStore(SqliteDatabase(db)).list_audit()
    assert rows, "CLI mutations must be recorded"
    assert all(row["actor_id"] is None for row in rows)
    assert {row["field"] for row in rows} == {"is_admin"}


def test_a_database_locked_by_a_running_server_is_reported_cleanly(db, capsys, monkeypatch):
    # UserStore.__init__ writes the schema on every single invocation, so a
    # lock held at that point — the exact moment a running server would hold
    # one — must be caught too, not just a lock hit mid-command.
    monkeypatch.setattr("app.manage._BUSY_TIMEOUT_SECONDS", 0.2)
    locker = sqlite3.connect(db)
    locker.execute("BEGIN EXCLUSIVE")
    try:
        assert run(db, "list-users") == 1
    finally:
        locker.rollback()
        locker.close()
    assert "busy" in capsys.readouterr().err.lower()


def test_a_corrupt_database_file_is_reported_cleanly_not_as_a_traceback(tmp_path, capsys):
    bad = tmp_path / "corrupt.db"
    bad.write_bytes(b"not a real sqlite database file, just garbage bytes")
    assert run(bad, "list-users") == 1
    err = capsys.readouterr().err.lower()
    assert "corrupt" in err or "unreadable" in err


def test_an_unopenable_database_path_is_reported_distinctly_from_busy(tmp_path, capsys):
    # sqlite3.OperationalError also covers "unable to open database file" —
    # --db pointed at a directory, a read-only file, or a parent directory
    # that couldn't be created — which has nothing to do with lock
    # contention. Mislabeling it "busy" would send an operator to wait out
    # a lock that does not exist. A directory is a clean, deterministic way
    # to provoke this without touching permissions.
    a_directory = tmp_path / "not-a-file"
    a_directory.mkdir()
    assert run(a_directory, "list-users") == 1
    err = capsys.readouterr().err.lower()
    assert "busy" not in err
    assert "could not open" in err


def test_a_non_lock_operational_error_in_a_handler_is_not_mislabeled_as_busy(db, monkeypatch):
    # sqlite3 gives lock contention and an ordinary bug (a typo'd column
    # name, schema drift) the *same* exception class. A real bug raised
    # from inside a handler must keep its traceback rather than being
    # mistaken for "the database is busy" and silently swallowed — that
    # would send an operator to wait out a lock that does not exist.
    def _boom(self, user_id, password):  # noqa: ARG001 - stand-in for a real bug
        raise sqlite3.OperationalError("no such column: bogus_field")

    monkeypatch.setattr(UserStore, "set_password", _boom)
    with pytest.raises(sqlite3.OperationalError):
        run(db, "set-password", "ada@example.com", password="a recovered password")


def test_make_admin_on_an_already_active_admin_is_a_true_no_op(db, capsys):
    assert run(db, "make-admin", "root@example.com") == 0
    assert UserStore(SqliteDatabase(db)).list_audit() == []
    assert "already" in capsys.readouterr().out.lower()


def test_revoke_admin_on_a_non_admin_is_a_true_no_op(db, capsys):
    assert run(db, "revoke-admin", "ada@example.com") == 0
    assert UserStore(SqliteDatabase(db)).list_audit() == []
    assert "already" in capsys.readouterr().out.lower()


def test_deactivate_an_already_inactive_user_is_a_true_no_op(db, capsys):
    store = UserStore(SqliteDatabase(db))
    store.update_user(2, is_active=False)
    assert run(db, "deactivate", "ada@example.com") == 0
    assert UserStore(SqliteDatabase(db)).list_audit() == []
    assert "already" in capsys.readouterr().out.lower()


def test_activate_an_already_active_user_is_a_true_no_op(db, capsys):
    assert run(db, "activate", "ada@example.com") == 0
    assert UserStore(SqliteDatabase(db)).list_audit() == []
    assert "already" in capsys.readouterr().out.lower()
