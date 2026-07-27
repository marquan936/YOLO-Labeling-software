"""Annotation CRUD API routes."""
from __future__ import annotations
from typing import Any, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import Database
from services.annotation_service import (
    get_annotations_for_image,
    save_annotations_for_image,
    merge_annotations,
    delete_annotations_for_image,
)

router = APIRouter(prefix="/api/v1/annotations", tags=["annotations"])


class AnnotationUpdate(BaseModel):
    annotations: list  # Accept any annotation dict (bbox or polygon)

    class Config:
        extra = "ignore"


def _validate_annotation_list(annotations: list):
    """Validate annotation dicts have required fields."""
    for i, ann in enumerate(annotations):
        if not isinstance(ann, dict):
            raise HTTPException(422, f'标注 [{i}] 必须是字典类型')
        ann_type = ann.get('type', 'bbox')
        if ann_type == 'polygon':
            pts = ann.get('points')
            if not pts or not isinstance(pts, list) or len(pts) < 3:
                raise HTTPException(422, f'多边形标注 [{i}] 缺少有效的 points 数组（至少3个顶点）')
            if 'class_id' not in ann:
                raise HTTPException(422, f'多边形标注 [{i}] 缺少 class_id')
        else:
            for field in ['class_id', 'x_center', 'y_center', 'width', 'height']:
                if field not in ann:
                    raise HTTPException(422, f'Bbox 标注 [{i}] 缺少必需字段: {field}')


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.get("/{image_id}")
def get_annotations(image_id: int):
    db = get_db()
    image = db.fetch_one("SELECT id FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    annotations = get_annotations_for_image(image_id, db)
    return {
        "image_id": image_id,
        "annotations": annotations,
        "source": "human",
        "count": len(annotations),
    }


@router.put("/{image_id}")
def update_annotations(image_id: int, body: AnnotationUpdate):
    _validate_annotation_list(body.annotations)
    db = get_db()
    image = db.fetch_one("SELECT id FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    # Clean extra frontend-only fields from each annotation
    anns = []
    for a in body.annotations:
        clean = {}
        for k, v in a.items():
            if not k.startswith('_'):
                clean[k] = v
        anns.append(clean)
    count = save_annotations_for_image(image_id, anns, db)
    return {"saved": count, "image_id": image_id}


@router.patch("/{image_id}")
def append_annotations(image_id: int, body: AnnotationUpdate):
    """Merge/append annotations with deduplication."""
    _validate_annotation_list(body.annotations)
    db = get_db()
    image = db.fetch_one("SELECT id FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    anns = []
    for a in body.annotations:
        clean = {}
        for k, v in a.items():
            if not k.startswith('_'):
                clean[k] = v
        anns.append(clean)
    total = merge_annotations(image_id, anns, db)
    return {"total": total, "image_id": image_id}


@router.delete("/{image_id}")
def delete_annotations(image_id: int, source: str = "human"):
    db = get_db()
    deleted = delete_annotations_for_image(image_id, db)
    return {"deleted": deleted}
