from __future__ import annotations
"""Image management API routes."""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from database import Database
from services.image_service import scan_images_directory, get_image_path, count_unannotated_images

router = APIRouter(prefix="/api/v1/images", tags=["images"])


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.get("")
def list_images(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    split: str = Query("", description="Filter by split: train or val"),
    status: str = Query("", description="Filter by review status"),
    search: str = Query("", description="Search filename"),
):
    db = get_db()
    conditions = []
    params = []

    if split:
        conditions.append("i.split = ?")
        params.append(split)
    if status:
        conditions.append("COALESCE(rs.status, 'pending') = ?")
        params.append(status)
    if search:
        conditions.append("i.filename LIKE ?")
        params.append(f"%{search}%")

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    count_sql = f"""
        SELECT COUNT(*) as cnt FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
        {where}
    """
    total = db.fetch_one(count_sql, params)["cnt"]

    offset = (page - 1) * per_page
    sql = f"""
        SELECT i.*,
               COALESCE(rs.status, 'pending') as review_status,
               COALESCE(rs.has_human_annotation, 0) as has_annotation,
               COALESCE(rs.has_model_prediction, 0) as has_prediction,
               COALESCE(rs.human_annotation_count, 0) as ann_count,
               COALESCE(rs.model_prediction_count, 0) as pred_count
        FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
        {where}
        ORDER BY i.filename
        LIMIT ? OFFSET ?
    """
    images = db.fetch_all(sql, params + [per_page, offset])

    return {"images": images, "total": total, "page": page, "per_page": per_page}


@router.get("/{image_id}")
def get_image(image_id: int):
    db = get_db()
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    rs = db.fetch_one(
        "SELECT * FROM review_status WHERE image_id = ?", (image_id,)
    )
    image["review_status"] = rs["status"] if rs else "pending"
    image["has_annotation"] = rs["has_human_annotation"] if rs else 0
    image["has_prediction"] = rs["has_model_prediction"] if rs else 0
    return image


@router.get("/{image_id}/file")
def serve_image(image_id: int):
    db = get_db()
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    filepath = get_image_path(image)
    if not Path(filepath).exists():
        raise HTTPException(404, "Image file not found on disk")

    return FileResponse(filepath)


@router.post("/scan")
def scan_images():
    db = get_db()
    result = scan_images_directory(db)
    total = db.fetch_one("SELECT COUNT(*) as cnt FROM images")["cnt"]
    result["total"] = total
    return result


@router.get("/stats/summary")
def image_stats():
    db = get_db()
    # Single query with LEFT JOIN so images without review_status rows are counted as unannotated
    row = db.fetch_one("""
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN i.split='train' THEN 1 ELSE 0 END) as train_count,
            SUM(CASE WHEN i.split='val' THEN 1 ELSE 0 END) as val_count,
            SUM(CASE WHEN COALESCE(rs.status, 'pending') = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
            SUM(CASE WHEN COALESCE(rs.status, 'pending') IN ('pending', 'skipped') OR rs.status IS NULL THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN COALESCE(rs.has_human_annotation, 0) = 1 OR COALESCE(rs.has_model_prediction, 0) = 1 THEN 1 ELSE 0 END) as annotated,
            SUM(CASE WHEN COALESCE(rs.has_model_prediction, 0) = 1 THEN 1 ELSE 0 END) as predicted,
            SUM(CASE WHEN COALESCE(rs.has_human_annotation, 0) = 0 AND COALESCE(rs.has_model_prediction, 0) = 0 THEN 1 ELSE 0 END) as unannotated
        FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
    """)
    unannotated = count_unannotated_images(db)
    return {
        "total": row["total"],
        "train_count": row["train_count"],
        "val_count": row["val_count"],
        "reviewed": row["reviewed"],
        "pending": row["pending"],
        "annotated": row["annotated"],
        "predicted": row["predicted"],
        "unannotated": unannotated,
    }


@router.put("/{image_id}/move")
def move_image(image_id: int, target_split: str = "train"):
    """Move an image between train/val splits."""
    if target_split not in ("train", "val"):
        raise HTTPException(400, "target_split must be 'train' or 'val'")

    db = get_db()
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    old_split = image["split"]
    if old_split == target_split:
        return {"status": "unchanged", "split": target_split}

    # Move image file
    old_path = Path(get_image_path(image))
    new_rel = image["relative_path"].replace(old_split + "/", target_split + "/", 1)
    new_path = IMAGE_DIR / new_rel
    new_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_path), str(new_path))

    # Move annotation files
    stem = Path(image["filename"]).stem
    for src_dir, dst_dir in [
        (ANNOTATION_DIR / old_split, ANNOTATION_DIR / target_split),
        (PREDICTION_DIR / old_split, PREDICTION_DIR / target_split),
    ]:
        for pattern in [f"{stem}.txt", f"{stem}_*.txt"]:
            for f in src_dir.glob(pattern):
                dst = dst_dir / f.name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(f), str(dst))

    # Update DB
    db.execute(
        "UPDATE images SET relative_path=?, split=?, updated_at=? WHERE id=?",
        (new_rel, target_split, datetime.utcnow().isoformat(), image_id),
    )
    return {"status": "moved", "split": target_split, "old_split": old_split}


@router.delete("/{image_id}")
def delete_image(image_id: int):
    """Delete an image and its annotations."""
    db = get_db()
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    # Delete image file
    img_path = Path(get_image_path(image))
    if img_path.exists():
        img_path.unlink()

    # Delete annotation files
    stem = Path(image["filename"]).stem
    for ann_dir in [
        ANNOTATION_DIR / image["split"],
        PREDICTION_DIR / image["split"],
    ]:
        for pattern in [f"{stem}.txt", f"{stem}_*.txt"]:
            for f in ann_dir.glob(pattern):
                if f.is_file():
                    f.unlink()

    # Delete DB records (cascade)
    db.execute("DELETE FROM annotation_files WHERE image_id=?", (image_id,))
    db.execute("DELETE FROM review_status WHERE image_id=?", (image_id,))
    db.execute("DELETE FROM images WHERE id=?", (image_id,))

    return {"deleted": image_id, "filename": image["filename"]}


import shutil
from datetime import datetime
from config import IMAGE_DIR, ANNOTATION_DIR, PREDICTION_DIR
from pathlib import Path
