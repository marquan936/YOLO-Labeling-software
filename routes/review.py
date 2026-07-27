from __future__ import annotations
"""Review management API routes."""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from pydantic import BaseModel

from database import Database
from services import review_service

router = APIRouter(prefix="/api/v1/review", tags=["review"])


class MarkRequest(BaseModel):
    status: str = "reviewed"  # "reviewed" or "skipped"
    notes: str = ""


class MarkBatchRequest(BaseModel):
    image_ids: list[int]
    status: str = "reviewed"


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.get("/status")
def review_status():
    db = get_db()
    stats = review_service.get_review_stats(db)
    total = stats.get("total_images", 0)
    reviewed = stats.get("reviewed", 0)
    pct = round(reviewed / total * 100, 1) if total > 0 else 0
    stats["pct_complete"] = pct
    return stats


@router.get("/queue")
def review_queue(page: int = Query(1, ge=1),
                 per_page: int = Query(50, ge=1, le=200)):
    db = get_db()
    return review_service.get_review_queue(db, page, per_page)


@router.get("/next")
def next_unreviewed(current_id: Optional[int] = None):
    db = get_db()
    return review_service.get_next_unreviewed(db, current_id)


@router.post("/unreview/{image_id}")
def unreview_image(image_id: int):
    """Reset an image's review status back to pending."""
    db = get_db()
    return review_service.unreview_image(image_id, db)


@router.post("/mark/{image_id}")
def mark_reviewed(image_id: int, body: MarkRequest):
    db = get_db()
    return review_service.mark_reviewed(image_id, body.status, body.notes, db)


@router.post("/mark-batch")
def mark_batch(body: MarkBatchRequest):
    db = get_db()
    return review_service.mark_batch_reviewed(body.image_ids, body.status, db)


@router.post("/mark-all")
def mark_all():
    db = get_db()
    return review_service.mark_all_as_reviewed(db)
