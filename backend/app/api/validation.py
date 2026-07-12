from fastapi import HTTPException


def validate_name(raw: str, *, message: str, max_len: int | None = None) -> str:
    """Shared name guard: strip, reject empty, optionally cap the length.

    The message is per-entity ("Document name must not be empty", ...) so
    existing client-visible 422 texts stay byte-identical.
    """
    name = raw.strip()
    if not name:
        raise HTTPException(422, message)
    if max_len is not None and len(name) > max_len:
        raise HTTPException(422, f"Folder name must be at most {max_len} characters")
    return name
