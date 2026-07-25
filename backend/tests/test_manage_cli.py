from pathlib import Path

import pytest

from app.core.config import Settings
from app.manage import main
from app.services.users import UserStore


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    path = tmp_path / "test.db"
    store = UserStore(path)
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
    store = UserStore(db)
    assert store.verify_credentials("ada@example.com", "a recovered password") is not None


def test_set_password_never_accepts_the_password_as_an_argument(db):
    # A password in argv lands in shell history and in `ps` output for every
    # other process on the machine.
    with pytest.raises(SystemExit):
        main(["--db", str(db), "set-password", "ada@example.com", "hunter2hunter2"])


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
    assert UserStore(db).verify_credentials("ada@example.com", "an initial password") is not None


def test_make_admin_grants_and_reactivates(db):
    store = UserStore(db)
    store.update_user(2, is_active=False)
    assert run(db, "make-admin", "ada@example.com") == 0
    user = store.get_user(2)
    assert user.is_admin is True and user.is_active is True


def test_revoke_admin_warns_but_proceeds_when_no_admin_remains(db, capsys):
    assert run(db, "revoke-admin", "root@example.com") == 0
    assert UserStore(db).get_user(1).is_admin is False
    # It must not refuse: freezing all admin access and then minting a fresh
    # one with make-admin is a legitimate incident response.
    assert "no admin" in capsys.readouterr().err.lower()


def test_deactivate_and_activate(db):
    store = UserStore(db)
    assert run(db, "deactivate", "ada@example.com") == 0
    assert store.get_user(2).is_active is False
    assert run(db, "activate", "ada@example.com") == 0
    assert store.get_user(2).is_active is True


def test_unknown_email_is_an_error(db, capsys):
    assert run(db, "make-admin", "nobody@example.com") == 1
    assert "not found" in capsys.readouterr().err.lower()


def test_every_mutation_is_audited_as_an_out_of_band_action(db):
    run(db, "make-admin", "ada@example.com")
    rows = UserStore(db).list_audit()
    assert rows, "CLI mutations must be recorded"
    assert all(row["actor_id"] is None for row in rows)
    assert {row["field"] for row in rows} == {"is_admin"}
