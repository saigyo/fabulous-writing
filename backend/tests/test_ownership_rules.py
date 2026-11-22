import pytest

from app.services.ownership import (
    GLOBAL_READ_ONLY_MESSAGE,
    GlobalReadOnlyError,
    is_visible,
    require_writable,
    visible_clause,
)


def test_visible_clause_names_the_column():
    assert visible_clause("d.owner_id") == "(d.owner_id IS NULL OR d.owner_id = ?)"


def test_global_row_is_visible_to_everyone_including_no_user():
    assert is_visible(None, user_id=1) is True
    assert is_visible(None, user_id=None) is True


def test_owned_row_is_visible_to_its_owner_only():
    assert is_visible(2, user_id=2) is True
    assert is_visible(2, user_id=1) is False
    assert is_visible(2, user_id=None) is False


def test_global_row_is_writable_by_admins_only():
    require_writable(None, is_admin=True)
    with pytest.raises(GlobalReadOnlyError, match=GLOBAL_READ_ONLY_MESSAGE):
        require_writable(None, is_admin=False)


def test_owned_row_is_writable_without_admin():
    require_writable(2, is_admin=False)
