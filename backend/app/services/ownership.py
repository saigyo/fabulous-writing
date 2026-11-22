"""The one ownership exception shared by the resource stores."""

GLOBAL_READ_ONLY_MESSAGE = "Only admins can change built-in items"


class GlobalReadOnlyError(Exception):
    """A non-admin tried to mutate a global (owner_id NULL) row."""


def visible_clause(column: str = "owner_id") -> str:
    """SQL condition for a row that is global or owned by the bound user (one `?`)."""
    return f"({column} IS NULL OR {column} = ?)"


def is_visible(row_owner_id: int | None, *, user_id: int | None) -> bool:
    return row_owner_id is None or row_owner_id == user_id


def require_writable(row_owner_id: int | None, *, is_admin: bool) -> None:
    if row_owner_id is None and not is_admin:
        raise GlobalReadOnlyError(GLOBAL_READ_ONLY_MESSAGE)
