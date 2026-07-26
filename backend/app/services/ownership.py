"""The one ownership exception shared by the resource stores."""


class GlobalReadOnlyError(Exception):
    """A non-admin tried to mutate a global (owner_id NULL) row."""
