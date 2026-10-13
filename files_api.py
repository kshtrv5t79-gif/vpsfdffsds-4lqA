"""HTTP layer for the file manager (list / upload / rename / move / copy /
permissions / archive / unarchive / download / delete / startup file).

All blocking disk work is done in plain `def` endpoints, which FastAPI runs
in a thread-pool, so big uploads or archives never freeze the panel.
"""
import os
import shutil
import tempfile
from typing import List, Callable

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

import file_ops as fo
from data_sandbox import safe_join
from json_db import db

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "200"))


class DirRequest(BaseModel):
    path: str = ""            # directory the action happens in ("" = root)


class NameRequest(DirRequest):
    name: str


class RenameRequest(DirRequest):
    old: str
    new: str


class ItemsRequest(DirRequest):
    items: List[str]


class MoveRequest(ItemsRequest):
    destination: str


class ChmodRequest(ItemsRequest):
    mode: str
    recursive: bool = False


class StartupRequest(BaseModel):
    path: str                 # full relative path of the .py file


def build_router(get_current_user: Callable, verify_bot_ownership: Callable) -> APIRouter:
    router = APIRouter(prefix="/api/bots/{bot_id}/fm")

    def bot_root(bot_id: str, user: dict) -> str:
        verify_bot_ownership(bot_id, user)
        root = os.path.abspath(os.path.join("data", "bots", bot_id))
        os.makedirs(root, exist_ok=True)
        return root

    def guarded(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except fo.FileOpError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e))
        except FileExistsError:
            raise HTTPException(status_code=400, detail="Item already exists.")
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Item not found.")
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Disk error: {e.strerror or e}")

    @router.get("/list")
    def list_directory(bot_id: str, path: str = "", user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        data = guarded(fo.list_dir, root, path)
        bot = db.get_bot(bot_id) or {}
        data["startup"] = bot.get("entrypoint", "")
        data["max_upload_mb"] = MAX_UPLOAD_MB
        return data

    @router.post("/mkdir")
    def make_directory(bot_id: str, req: NameRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        guarded(fo.make_dir, root, req.path, req.name)
        return {"status": "success"}

    @router.post("/newfile")
    def new_file(bot_id: str, req: NameRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        created = guarded(fo.make_file, root, req.path, req.name)
        return {"status": "success", "path": created}

    @router.post("/rename")
    def rename_item(bot_id: str, req: RenameRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        new_rel = guarded(fo.rename, root, req.path, req.old, req.new)
        # keep the startup file pointing at the right place after a rename/move
        bot = db.get_bot(bot_id) or {}
        ep = bot.get("entrypoint", "")
        old_rel = fo.join_rel(req.path, req.old)
        if ep == old_rel:
            db.update_bot(bot_id, {"entrypoint": new_rel})
        elif ep.startswith(old_rel + "/"):
            db.update_bot(bot_id, {"entrypoint": new_rel + ep[len(old_rel):]})
        return {"status": "success"}

    @router.post("/move")
    def move_items(bot_id: str, req: MoveRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        guarded(fo.move, root, req.path, req.items, req.destination)
        bot = db.get_bot(bot_id) or {}
        ep = bot.get("entrypoint", "")
        dest = req.destination.strip("/")
        for n in req.items:
            old_rel = fo.join_rel(req.path, n)
            if ep == old_rel or ep.startswith(old_rel + "/"):
                db.update_bot(bot_id, {"entrypoint": fo.join_rel(dest, n) + ep[len(old_rel):]})
                break
        return {"status": "success"}

    @router.post("/copy")
    def copy_item(bot_id: str, req: NameRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        new_name = guarded(fo.copy, root, req.path, req.name)
        return {"status": "success", "name": new_name}

    @router.post("/chmod")
    def chmod_items(bot_id: str, req: ChmodRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        guarded(fo.chmod, root, req.path, req.items, req.mode, req.recursive)
        return {"status": "success"}

    @router.post("/delete")
    def delete_items(bot_id: str, req: ItemsRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        guarded(fo.delete, root, req.path, req.items)
        return {"status": "success"}

    @router.post("/archive")
    def archive_items(bot_id: str, req: ItemsRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        name = guarded(fo.archive, root, req.path, req.items)
        return {"status": "success", "name": name}

    @router.post("/unarchive")
    def unarchive_item(bot_id: str, req: NameRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        guarded(fo.unarchive, root, req.path, req.name)
        return {"status": "success"}

    @router.get("/download")
    def download(bot_id: str, path: str, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        target = guarded(safe_join, root, path)
        if os.path.isdir(target):
            tmp = tempfile.mkdtemp(prefix="dl_")
            zip_path = guarded(fo.zip_folder_to_temp, root, path, tmp)
            return FileResponse(
                zip_path,
                filename=os.path.basename(zip_path),
                media_type="application/zip",
                background=BackgroundTask(shutil.rmtree, tmp, True),
            )
        if not os.path.isfile(target):
            raise HTTPException(status_code=404, detail="File not found.")
        return FileResponse(target, filename=os.path.basename(target),
                            media_type="application/octet-stream")

    @router.post("/upload")
    def upload(
        bot_id: str,
        files: List[UploadFile] = File(...),
        path: str = Form(""),
        user: dict = Depends(get_current_user),
    ):
        root = bot_root(bot_id, user)
        max_bytes = MAX_UPLOAD_MB * 1024 * 1024
        saved = []
        for f in files:
            saved.append(guarded(fo.save_upload, root, path, f.filename, f.file, max_bytes))
        return {"status": "success", "saved": saved}

    @router.post("/startup")
    def set_startup(bot_id: str, req: StartupRequest, user: dict = Depends(get_current_user)):
        root = bot_root(bot_id, user)
        ep = guarded(fo.validate_entrypoint, root, req.path)
        db.update_bot(bot_id, {"entrypoint": ep})
        return {"status": "success", "entrypoint": ep}

    return router
