from pathlib import Path

import pytest

from app.services import users as users_module
from app.services.users import DuplicateEmailError, InvalidEmailError, UserStore


@pytest.fixture()
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "test.db")


def test_create_and_read_back(store):
    user = store.create_user("Ada@example.com", "correct horse battery", display_name="Ada")
    assert user.id == 1 and user.email == "Ada@example.com"
    assert user.tier == "basic" and user.is_admin is False and user.is_active is True
    assert user.created_at
    assert store.get_user(user.id) == user
    assert store.get_user(999) is None


def test_user_model_never_exposes_password_material(store):
    user = store.create_user("ada@example.com", "correct horse battery")
    assert "password" not in user.model_dump()


def test_email_lookup_and_uniqueness_are_case_insensitive(store):
    store.create_user("ada@example.com", "correct horse battery")
    assert store.get_by_email("ADA@Example.com") is not None
    with pytest.raises(DuplicateEmailError):
        store.create_user("ADA@example.com", "another password")


def test_email_whitespace_is_stripped_on_create_and_stored_value(store):
    user = store.create_user("  ada@example.com  ", "correct horse battery")
    # Stored/returned value has no surrounding whitespace, but case is
    # preserved (COLLATE NOCASE already handles case-insensitivity; the
    # store must not also lowercase).
    assert user.email == "ada@example.com"


def test_email_with_surrounding_whitespace_resolves_to_same_account(store):
    created = store.create_user("ada@example.com", "correct horse battery")
    assert store.get_by_email(" ada@example.com ") == created
    assert store.get_by_email("ada@example.com\t") == created


def test_email_with_surrounding_whitespace_logs_in_to_same_account(store):
    store.create_user("ada@example.com", "correct horse battery")
    user = store.verify_credentials("  ada@example.com  ", "correct horse battery")
    assert user is not None and user.email == "ada@example.com"


@pytest.mark.parametrize("email", ["", "   ", "\t\n "])
def test_create_user_rejects_empty_or_whitespace_only_email(store, email):
    # The last line of defence: the request models reject this before it
    # gets here, but any caller that bypasses them (the operator CLI's own
    # future use, seed_admin's underlying call) must not be able to create
    # an addressless account by relying on the store's own stripping to
    # normalize whitespace down to ''.
    with pytest.raises(InvalidEmailError):
        store.create_user(email, "correct horse battery")
    assert store.count() == 0


def test_create_user_rejects_whitespace_variant_of_existing_email(store):
    store.create_user("x@example.com", "correct horse battery")
    with pytest.raises(DuplicateEmailError):
        store.create_user("x@example.com ", "another password")
    with pytest.raises(DuplicateEmailError):
        store.create_user(" x@example.com", "another password")


def test_verify_credentials(store):
    store.create_user("ada@example.com", "correct horse battery")
    assert store.verify_credentials("ADA@example.com", "correct horse battery") is not None
    assert store.verify_credentials("ada@example.com", "wrong") is None
    assert store.verify_credentials("nobody@example.com", "correct horse battery") is None


def test_deactivated_user_cannot_authenticate(store):
    user = store.create_user("ada@example.com", "correct horse battery")
    store.update_user(user.id, is_active=False)
    assert store.verify_credentials("ada@example.com", "correct horse battery") is None


def test_update_user_changes_only_named_fields(store):
    user = store.create_user("ada@example.com", "correct horse battery", display_name="Ada")
    updated = store.update_user(user.id, tier="premium", is_admin=True)
    assert updated.tier == "premium" and updated.is_admin is True
    assert updated.display_name == "Ada" and updated.is_active is True
    assert store.update_user(999, tier="premium") is None


def test_set_password_replaces_the_credential(store):
    user = store.create_user("ada@example.com", "old password here")
    assert store.set_password(user.id, "new password here") is True
    assert store.verify_credentials("ada@example.com", "old password here") is None
    assert store.verify_credentials("ada@example.com", "new password here") is not None
    assert store.set_password(999, "irrelevant") is False


def test_set_password_records_when_it_changed(store):
    user = store.create_user("ada@example.com", "old password here")
    assert store.get_user(user.id).password_changed_at is None
    assert store.set_password(user.id, "new password here") is True
    changed = store.get_user(user.id).password_changed_at
    assert changed  # ISO 8601 UTC, same convention as created_at


def test_count_and_list(store):
    assert store.count() == 0
    store.create_user("b@example.com", "correct horse battery")
    store.create_user("a@example.com", "correct horse battery")
    assert store.count() == 2
    assert [u.email for u in store.list_users()] == ["a@example.com", "b@example.com"]


def test_verify_credentials_spends_bcrypt_time_on_unknown_email(store, monkeypatch):
    """Regression test for a timing oracle: verify_credentials must call
    check_password on every path, including an unknown email, so that an
    unknown account cannot be distinguished from a known account with a
    wrong password by response timing. A naive `if row is None: return
    None` added before the check_password call would skip it for unknown
    emails and reintroduce exactly that oracle — this test would then see
    zero calls for the unknown-email case while the known-wrong-password
    case still shows one.
    """
    store.create_user("ada@example.com", "correct horse battery")

    calls: list[str | None] = []
    real_check_password = users_module.check_password

    def counting_check_password(password: str, password_hash: str | None) -> bool:
        calls.append(password_hash)
        return real_check_password(password, password_hash)

    monkeypatch.setattr(users_module, "check_password", counting_check_password)

    calls.clear()
    store.verify_credentials("ada@example.com", "wrong password here")
    known_wrong_password_calls = len(calls)

    calls.clear()
    store.verify_credentials("nobody@example.com", "correct horse battery")
    unknown_email_calls = len(calls)

    assert known_wrong_password_calls == unknown_email_calls == 1


def test_audit_rows_record_the_actor_or_none_for_cli(store):
    admin = store.create_user("admin@example.com", "correct horse battery", is_admin=True)
    target = store.create_user("ada@example.com", "correct horse battery")
    store.record_audit(actor_id=admin.id, target_id=target.id, field="tier",
                       old_value="basic", new_value="premium")
    store.record_audit(actor_id=None, target_id=target.id, field="password")
    rows = store.list_audit()
    assert [(r["actor_id"], r["field"]) for r in rows] == [
        (admin.id, "tier"),
        (None, "password"),  # None marks an out-of-band operator CLI action
    ]
    assert all(r["created_at"] for r in rows)


def test_set_password_bumps_token_epoch(tmp_path):
    store = UserStore(tmp_path / "u.db")
    user = store.create_user("epoch@example.com", "password-one")
    assert user.token_epoch == 0
    store.set_password(user.id, "password-two")
    assert store.get_user(user.id).token_epoch == 1
    store.set_password(user.id, "password-three")
    assert store.get_user(user.id).token_epoch == 2


def test_token_epoch_is_not_serialized(tmp_path):
    store = UserStore(tmp_path / "u.db")
    user = store.create_user("epoch2@example.com", "password-one")
    assert "token_epoch" not in user.model_dump()
