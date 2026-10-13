import os


def safe_join(base_dir: str, *paths: str) -> str:
    """Safely joins paths ensuring that the result is strictly inside base_dir.
    Prevents directory traversal (../..), sibling-prefix tricks
    (bot_1 vs bot_10) and symlink escapes.
    """
    resolved_base = os.path.realpath(base_dir)
    cleaned = [p.lstrip("/\\") for p in paths]
    joined = os.path.join(resolved_base, *cleaned)
    resolved_joined = os.path.realpath(joined)

    if resolved_joined != resolved_base and not resolved_joined.startswith(resolved_base + os.sep):
        raise PermissionError("Access Denied: Path traversal detected!")

    return resolved_joined
