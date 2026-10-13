"""File-manager operations for a bot sandbox directory.

Everything here works with paths *relative to the bot root* (using "/"),
and every path is validated through safe_join so nothing can escape the
bot's own folder.  No web framework is imported on purpose, so the logic
can be tested on its own.
"""
import os
import re
import shutil
import stat
import tarfile
import zipfile
import datetime
from typing import List, Dict, Any, BinaryIO

from data_sandbox import safe_join

MAX_EDIT_BYTES = 2 * 1024 * 1024            # files above this are download-only
MAX_UNARCHIVE_BYTES = 1024 * 1024 * 1024    # 1 GiB total after extraction
MAX_UNARCHIVE_FILES = 20000

ARCHIVE_EXTS = (".zip", ".tar", ".tar.gz", ".tgz")
BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
    ".tar", ".tgz", ".7z", ".rar", ".so", ".dll", ".exe", ".pyc", ".mp3",
    ".mp4", ".mov", ".avi", ".woff", ".woff2", ".ttf", ".otf", ".sqlite",
    ".db", ".bin", ".whl",
}


class FileOpError(Exception):
    """Raised with a user-friendly message; the API turns it into HTTP 400."""


# ---------------------------------------------------------------- helpers

def validate_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise FileOpError("Name cannot be empty.")
    if "/" in name or "\\" in name or "\x00" in name:
        raise FileOpError("Name cannot contain slashes.")
    if name in (".", ".."):
        raise FileOpError("Invalid name.")
    if len(name) > 255:
        raise FileOpError("Name is too long.")
    return name


def rel_of(root: str, abs_path: str) -> str:
    rel = os.path.relpath(abs_path, os.path.realpath(root))
    return "" if rel == "." else rel.replace("\\", "/")


def join_rel(*parts: str) -> str:
    return "/".join(p.strip("/") for p in parts if p and p.strip("/"))


def own(path: str) -> None:
    """When the manager runs as root, hand files to the sandbox user
    ('nobody') exactly like BotManager.start_bot does, so a running bot can
    still read/write what was uploaded or created from the panel."""
    if os.name == "nt":
        return
    try:
        if os.getuid() != 0:
            return
    except Exception:
        return
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.chown(path, user="nobody", group="nogroup")
            for r, dirs, files in os.walk(path):
                for n in dirs + files:
                    p = os.path.join(r, n)
                    if not os.path.islink(p):
                        shutil.chown(p, user="nobody", group="nogroup")
        elif not os.path.islink(path):
            shutil.chown(path, user="nobody", group="nogroup")
    except Exception:
        pass


def is_archive_name(name: str) -> bool:
    return name.lower().endswith(ARCHIVE_EXTS)


def looks_editable(abs_path: str, size: int) -> bool:
    if size > MAX_EDIT_BYTES:
        return False
    ext = os.path.splitext(abs_path)[1].lower()
    if ext in BINARY_EXTS:
        return False
    try:
        with open(abs_path, "rb") as f:
            return b"\x00" not in f.read(4096)
    except Exception:
        return False


def unique_name(directory: str, name: str) -> str:
    """'a.py' -> 'a copy.py' -> 'a copy 2.py' ..."""
    base, ext = os.path.splitext(name)
    if name.lower().endswith(".tar.gz"):
        base, ext = name[:-7], ".tar.gz"
    candidate = f"{base} copy{ext}"
    i = 2
    while os.path.exists(os.path.join(directory, candidate)):
        candidate = f"{base} copy {i}{ext}"
        i += 1
    return candidate


# ---------------------------------------------------------------- listing

def list_dir(root: str, rel: str) -> Dict[str, Any]:
    target = safe_join(root, rel)
    if not os.path.isdir(target):
        raise FileOpError("Directory not found.")

    entries: List[Dict[str, Any]] = []
    with os.scandir(target) as it:
        for e in it:
            try:
                st = e.stat(follow_symlinks=False)
                is_dir = e.is_dir(follow_symlinks=False)
                is_link = e.is_symlink()
            except OSError:
                continue
            size = 0 if is_dir else st.st_size
            entries.append({
                "name": e.name,
                "is_dir": is_dir,
                "is_symlink": is_link,
                "size": size,
                "modified": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(),
                "mode": format(stat.S_IMODE(st.st_mode), "o").zfill(3),
                "is_archive": (not is_dir) and is_archive_name(e.name),
                "editable": (not is_dir) and (not is_link) and looks_editable(e.path, size),
            })
    entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return {"path": rel_of(root, target), "entries": entries}


# ------------------------------------------------------------- operations

def make_dir(root: str, rel_dir: str, name: str) -> None:
    name = validate_name(name)
    target = safe_join(root, rel_dir, name)
    if os.path.exists(target):
        raise FileOpError(f"'{name}' already exists.")
    os.makedirs(target)
    own(target)


def make_file(root: str, rel_dir: str, name: str) -> str:
    """Create an empty file. `name` may contain '/' sub-folders (like the
    old 'utils/helper.py' prompt) - they are created on the way."""
    name = (name or "").strip().strip("/")
    if not name:
        raise FileOpError("Name cannot be empty.")
    for part in name.split("/"):
        validate_name(part)
    target = safe_join(root, rel_dir, name)
    if os.path.exists(target):
        raise FileOpError(f"'{name}' already exists.")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8"):
        pass
    own(os.path.dirname(target))
    own(target)
    return rel_of(root, target)


def rename(root: str, rel_dir: str, old: str, new: str) -> str:
    old = validate_name(old)
    new = validate_name(new)
    src = safe_join(root, rel_dir, old)
    dst = safe_join(root, rel_dir, new)
    if not os.path.lexists(src):
        raise FileOpError(f"'{old}' not found.")
    if os.path.lexists(dst):
        raise FileOpError(f"'{new}' already exists.")
    os.rename(src, dst)
    return rel_of(root, dst)


def move(root: str, rel_dir: str, names: List[str], dest_rel: str) -> None:
    dest = safe_join(root, dest_rel)
    os.makedirs(dest, exist_ok=True)
    own(dest)
    for n in names:
        n = validate_name(n)
        src = safe_join(root, rel_dir, n)
        if not os.path.lexists(src):
            raise FileOpError(f"'{n}' not found.")
        if os.path.isdir(src) and (dest == src or dest.startswith(src + os.sep)):
            raise FileOpError(f"Cannot move folder '{n}' into itself.")
        final = os.path.join(dest, n)
        if os.path.lexists(final):
            raise FileOpError(f"'{n}' already exists in the destination.")
        shutil.move(src, final)


def copy(root: str, rel_dir: str, name: str) -> str:
    name = validate_name(name)
    src = safe_join(root, rel_dir, name)
    if not os.path.lexists(src):
        raise FileOpError(f"'{name}' not found.")
    new_name = unique_name(os.path.dirname(src), name)
    dst = os.path.join(os.path.dirname(src), new_name)
    if os.path.isdir(src):
        shutil.copytree(src, dst, symlinks=True)
    else:
        shutil.copy2(src, dst)
    own(dst)
    return new_name


def chmod(root: str, rel_dir: str, names: List[str], mode: str, recursive: bool = False) -> None:
    if not re.fullmatch(r"[0-7]{3,4}", mode or ""):
        raise FileOpError("Mode must be octal, like 644 or 755.")
    value = int(mode, 8)
    for n in names:
        n = validate_name(n)
        p = safe_join(root, rel_dir, n)
        if not os.path.lexists(p):
            raise FileOpError(f"'{n}' not found.")
        os.chmod(p, value)
        if recursive and os.path.isdir(p):
            for r, dirs, files in os.walk(p):
                for x in dirs + files:
                    fp = os.path.join(r, x)
                    if not os.path.islink(fp):
                        os.chmod(fp, value)


def delete(root: str, rel_dir: str, names: List[str]) -> None:
    for n in names:
        n = validate_name(n)
        p = safe_join(root, rel_dir, n)
        if not os.path.lexists(p):
            continue
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.remove(p)


# --------------------------------------------------------------- archives

def archive(root: str, rel_dir: str, names: List[str]) -> str:
    """Zip the given items into '<rel_dir>/archive-<timestamp>.zip'."""
    if not names:
        raise FileOpError("Nothing selected.")
    base_dir = safe_join(root, rel_dir)
    stamp = datetime.datetime.now().strftime("%Y-%m-%dT%H%M%S")
    out_name = f"archive-{stamp}.zip"
    out_path = os.path.join(base_dir, out_name)

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for n in names:
            n = validate_name(n)
            src = safe_join(root, rel_dir, n)
            if not os.path.lexists(src):
                raise FileOpError(f"'{n}' not found.")
            if os.path.isdir(src) and not os.path.islink(src):
                zf.write(src, n)
                for r, dirs, files in os.walk(src):
                    for d in dirs:
                        full = os.path.join(r, d)
                        if not os.path.islink(full):
                            zf.write(full, os.path.relpath(full, base_dir))
                    for f in files:
                        full = os.path.join(r, f)
                        if full == out_path or os.path.islink(full):
                            continue
                        zf.write(full, os.path.relpath(full, base_dir))
            elif not os.path.islink(src):
                zf.write(src, n)
    own(out_path)
    return out_name


def unarchive(root: str, rel_dir: str, name: str) -> None:
    name = validate_name(name)
    src = safe_join(root, rel_dir, name)
    dest = safe_join(root, rel_dir)
    if not os.path.isfile(src):
        raise FileOpError(f"'{name}' not found.")
    lower = name.lower()

    total = 0
    count = 0

    def _check(size: int):
        nonlocal total, count
        total += size
        count += 1
        if total > MAX_UNARCHIVE_BYTES or count > MAX_UNARCHIVE_FILES:
            raise FileOpError("Archive is too large to extract.")

    if lower.endswith(".zip"):
        try:
            zf = zipfile.ZipFile(src)
        except zipfile.BadZipFile:
            raise FileOpError("Not a valid zip file.")
        with zf:
            for info in zf.infolist():
                target = safe_join(dest, info.filename)      # blocks zip-slip
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    continue                                   # never create symlinks
                _check(info.file_size)
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as s, open(target, "wb") as d:
                    shutil.copyfileobj(s, d)
    elif lower.endswith((".tar", ".tar.gz", ".tgz")):
        try:
            tf = tarfile.open(src)
        except tarfile.TarError:
            raise FileOpError("Not a valid tar file.")
        with tf:
            for m in tf.getmembers():
                if not (m.isfile() or m.isdir()):
                    continue                                   # skip links/devices
                target = safe_join(dest, m.name)
                _check(m.size)
                if m.isdir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                s = tf.extractfile(m)
                if s is None:
                    continue
                with s, open(target, "wb") as d:
                    shutil.copyfileobj(s, d)
    else:
        raise FileOpError("Unsupported archive type (use .zip, .tar, .tar.gz).")
    own(dest)


def zip_folder_to_temp(root: str, rel: str, tmp_dir: str) -> str:
    """Zip a folder for download. Returns the temp zip path."""
    src = safe_join(root, rel)
    if not os.path.isdir(src):
        raise FileOpError("Folder not found.")
    base = os.path.basename(src) or "bot"
    out = os.path.join(tmp_dir, f"{base}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for r, dirs, files in os.walk(src):
            for d in dirs:
                full = os.path.join(r, d)
                if not os.path.islink(full):
                    zf.write(full, os.path.relpath(full, os.path.dirname(src)))
            for f in files:
                full = os.path.join(r, f)
                if not os.path.islink(full):
                    zf.write(full, os.path.relpath(full, os.path.dirname(src)))
    return out


# ----------------------------------------------------------------- upload

def save_upload(root: str, rel_dir: str, filename: str, fileobj: BinaryIO, max_bytes: int) -> str:
    """Stream an uploaded file to disk. `filename` may be a relative path
    ('folder/sub/file.py') when a whole folder was dropped."""
    filename = (filename or "").replace("\\", "/").strip("/")
    parts = [p for p in filename.split("/") if p]
    if not parts:
        raise FileOpError("Upload has no file name.")
    for p in parts:
        validate_name(p)
    target = safe_join(root, rel_dir, *parts)
    os.makedirs(os.path.dirname(target), exist_ok=True)

    written = 0
    try:
        with open(target, "wb") as out:
            while True:
                chunk = fileobj.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise FileOpError(
                        f"'{parts[-1]}' is larger than the {max_bytes // (1024 * 1024)} MB upload limit."
                    )
                out.write(chunk)
    except Exception:
        if os.path.exists(target):
            os.remove(target)
        raise
    own(os.path.dirname(target))
    own(target)
    return rel_of(root, target)


# ---------------------------------------------------------------- startup

def validate_entrypoint(root: str, entrypoint: str) -> str:
    """Normalise a startup file: relative path to an existing .py file."""
    ep = (entrypoint or "").replace("\\", "/").strip().lstrip("/")
    if not ep or not ep.endswith(".py"):
        raise FileOpError("Startup file must be a .py file.")
    if any(p in ("", ".", "..") for p in ep.split("/")):
        raise FileOpError("Invalid startup file path.")
    target = safe_join(root, ep)
    if not os.path.isfile(target):
        raise FileOpError(f"'{ep}' does not exist.")
    return ep


def dir_size(path: str) -> int:
    total = 0
    for r, dirs, files in os.walk(path):
        for f in files:
            try:
                fp = os.path.join(r, f)
                if not os.path.islink(fp):
                    total += os.path.getsize(fp)
            except OSError:
                pass
    return total
