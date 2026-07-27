from __future__ import annotations
"""Export API routes."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import Database
from services import export_service

router = APIRouter(prefix="/api/v1/export", tags=["export"])


class ExportRequest(BaseModel):
    source: str = "all"  # "all" | "reviewed" | "human" | "model"
    split: str = "all"   # "train" | "val" | "all"


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.post("")
def create_export(body: ExportRequest):
    db = get_db()
    try:
        task_id = export_service.export_dataset(body.source, body.split, db)
        return {
            "task_id": task_id,
            "download_url": f"/api/v1/export/download/{task_id}",
        }
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/download/{task_id}")
def download_export(task_id: str):
    task = export_service.get_export_task(task_id)
    if not task:
        raise HTTPException(404, "Export task not found")

    zip_path = task["zip_path"]
    from pathlib import Path
    if not Path(zip_path).exists():
        raise HTTPException(404, "Export file no longer available")

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"annotations_{task_id}.zip",
    )
