from __future__ import annotations
"""Class definitions API routes."""
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import Database
from config import DEFAULT_COLORS, CLASSES_FILE

router = APIRouter(prefix="/api/v1/classes", tags=["classes"])


class ClassItem(BaseModel):
    idx: Optional[int] = None
    name: str
    color: Optional[str] = None


class ClassUpdate(BaseModel):
    classes: list[ClassItem]


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


def _sync_classes_file(db: Database):
    """Write class definitions to data/classes.txt."""
    classes = db.fetch_all("SELECT * FROM class_definitions ORDER BY idx")
    with open(CLASSES_FILE, 'w') as f:
        for c in classes:
            f.write(f"{c['name']}\n")


@router.get("")
def get_classes():
    db = get_db()
    classes = db.fetch_all("SELECT idx, name, color FROM class_definitions ORDER BY idx")
    return {"classes": classes}


@router.put("")
def update_classes(body: ClassUpdate):
    db = get_db()
    # Clear existing
    db.execute("DELETE FROM class_definitions")
    colors = list(DEFAULT_COLORS)
    for i, item in enumerate(body.classes):
        idx = item.idx if item.idx is not None else i
        color = item.color or colors[i % len(colors)]
        db.execute(
            "INSERT OR REPLACE INTO class_definitions (idx, name, color) VALUES (?, ?, ?)",
            (idx, item.name, color),
        )
    _sync_classes_file(db)
    return {"classes": get_classes()["classes"], "saved": True}


@router.post("/from-model")
def import_classes_from_model():
    """Import class names from the currently loaded model."""
    try:
        from services.model_service import get_loaded_model
        model_info = get_loaded_model()
        if not model_info:
            raise HTTPException(400, "No model loaded")
    except ImportError:
        raise HTTPException(400, "No model loaded")

    model = model_info["model"]
    raw_names = model.names if hasattr(model, 'names') else {}

    # Handle both dict {0:'person',1:'car'} and list ['person','car'] formats
    if isinstance(raw_names, dict):
        names_dict = {int(k): str(v) for k, v in raw_names.items()}
    elif isinstance(raw_names, (list, tuple)):
        names_dict = {i: str(v) for i, v in enumerate(raw_names)}
    else:
        names_dict = {}

    if not names_dict:
        raise HTTPException(400, "Model has no class names")

    db = get_db()
    db.execute("DELETE FROM class_definitions")
    colors = list(DEFAULT_COLORS)
    for idx, name in names_dict.items():
        color = colors[int(idx) % len(colors)]
        db.execute(
            "INSERT INTO class_definitions (idx, name, color) VALUES (?, ?, ?)",
            (int(idx), str(name), color),
        )
    _sync_classes_file(db)
    return {"classes": get_classes()["classes"], "count": len(names_dict)}
