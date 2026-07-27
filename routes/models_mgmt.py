"""Model management API routes."""
from __future__ import annotations
import os
import shutil
from typing import Optional
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from database import Database
from services import model_service
from config import MODEL_DIR

router = APIRouter(prefix="/api/v1/models", tags=["models"])


class DownloadRequest(BaseModel):
    name: str


class LoadRequest(BaseModel):
    model_id: Optional[int] = None
    name: Optional[str] = None
    device: Optional[str] = None  # 'cuda', 'cpu', 'auto', or None for auto-detect


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.get("")
def list_models():
    db = get_db()
    models = model_service.list_models(db)
    loaded = model_service.get_loaded_model()
    loaded_name = loaded["info"]["name"] if loaded else None
    for m in models:
        m["is_currently_loaded"] = (m["name"] == loaded_name)
    return {"models": models, "loaded_model": loaded_name}


@router.get("/available")
def available_models():
    return {"models": model_service.list_available_pretrained()}


@router.post("/download")
def download_model(body: DownloadRequest):
    db = get_db()
    try:
        result = model_service.download_model(body.name, db)
        return result
    except Exception as e:
        raise HTTPException(500, f"Download failed: {str(e)}")


@router.post("/load")
def load_model(body: LoadRequest):
    db = get_db()
    model_id = body.model_id
    if not model_id and body.name:
        model = db.fetch_one("SELECT id FROM models WHERE name=?", (body.name,))
        if model:
            model_id = model["id"]
    if not model_id:
        raise HTTPException(400, "Specify model_id or name")

    try:
        result = model_service.load_model(model_id, db, device=body.device)
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to load model: {str(e)}")


@router.get("/device-info")
def get_device_info():
    """Get information about available compute devices."""
    return model_service.get_available_device()


@router.post("/unload")
def unload_model():
    db = get_db()
    return model_service.unload_model(db)


@router.post("/upload")
async def upload_local_model(file: UploadFile = File(...)):
    """Upload a local .pt model file."""
    if not file.filename or not file.filename.endswith('.pt'):
        raise HTTPException(400, "Only .pt model files are supported")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    filepath = MODEL_DIR / file.filename

    # Save uploaded file
    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)

    # Register in DB
    db = get_db()
    model_service.register_local_model(str(filepath), db)

    return {
        "status": "uploaded",
        "name": file.filename,
        "file_path": str(filepath),
        "size_bytes": len(content),
    }


@router.post("/scan-local")
def scan_local_models():
    """Scan data/models/ directory for .pt files and register them."""
    db = get_db()
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    found = []
    for f in MODEL_DIR.iterdir():
        if f.is_file() and f.suffix in ('.pt', '.pth'):
            try:
                model_service.register_local_model(str(f), db)
                found.append(f.name)
            except Exception:
                pass
    return {"found": found, "count": len(found)}


@router.post("/register-local")
def register_local(file_path: str):
    """Register a locally available .pt file by path."""
    db = get_db()
    try:
        model_service.register_local_model(file_path, db)
        return {"status": "registered", "file_path": file_path}
    except Exception as e:
        raise HTTPException(400, str(e))
