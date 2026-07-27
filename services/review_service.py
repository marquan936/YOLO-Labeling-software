from __future__ import annotations
"""Review queue and progress tracking service."""
import typing
from datetime import datetime
import typing

from database import Database


def get_review_stats(db: Database) -> dict:
    """Get aggregate review statistics."""
    row = db.fetch_one("""
        SELECT
            COUNT(*) as total_images,
            SUM(CASE WHEN rs.status = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
            SUM(CASE WHEN rs.status = 'skipped' THEN 1 ELSE 0 END) as skipped,
            SUM(CASE WHEN COALESCE(rs.status, 'pending') = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN COALESCE(rs.has_human_annotation, 0) = 1 THEN 1 ELSE 0 END) as annotated,
            SUM(CASE WHEN COALESCE(rs.has_model_prediction, 0) = 1 THEN 1 ELSE 0 END) as predicted
        FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
    """)
    return row


def get_review_queue(db: Database, page: int = 1, per_page: int = 50) -> dict:
    """Get paginated list of pending images."""
    offset = (page - 1) * per_page

    total = db.fetch_one("""
        SELECT COUNT(*) as cnt FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
        WHERE COALESCE(rs.status, 'pending') = 'pending'
    """)["cnt"]

    images = db.fetch_all("""
        SELECT i.*,
               COALESCE(rs.status, 'pending') as review_status,
               COALESCE(rs.has_human_annotation, 0) as has_annotation,
               COALESCE(rs.has_model_prediction, 0) as has_prediction,
               COALESCE(rs.human_annotation_count, 0) as ann_count,
               COALESCE(rs.model_prediction_count, 0) as pred_count
        FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
        WHERE COALESCE(rs.status, 'pending') = 'pending'
        ORDER BY i.filename ASC
        LIMIT ? OFFSET ?
    """, (per_page, offset))

    return {"images": images, "total": total, "page": page}


def get_next_unreviewed(db: Database, current_id: typing.Optional[int] = None) -> typing.Optional[dict]:
    """Get the next pending (unreviewed) image after ``current_id``.

    Pending images are ordered by filename then id. If ``current_id`` is still
    pending, return the next item in that queue (wrap when at end). If
    ``current_id`` was already reviewed/skipped, return the first pending image
    whose filename is greater than the current one, wrapping to the start.
    """
    try:
        from services.image_service import update_review_status_from_disk
        update_review_status_from_disk(db)
    except Exception:
        pass

    pending_rows = db.fetch_all("""
        SELECT i.id, i.filename FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
        WHERE COALESCE(rs.status, 'pending') = 'pending'
        ORDER BY i.filename ASC, i.id ASC
    """)
    if not pending_rows:
        return {"image_id": None}

    pending_ids = [row["id"] for row in pending_rows]

    if not current_id:
        return {"image_id": pending_ids[0]}

    if current_id in pending_ids:
        idx = pending_ids.index(current_id)
        if idx + 1 < len(pending_ids):
            return {"image_id": pending_ids[idx + 1]}
        if len(pending_ids) > 1:
            return {"image_id": pending_ids[0]}
        return {"image_id": None}

    cur = db.fetch_one("SELECT filename FROM images WHERE id = ?", (current_id,))
    cur_name = cur["filename"] if cur else ""
    for row in pending_rows:
        if row["filename"] > cur_name:
            return {"image_id": row["id"]}
    return {"image_id": pending_ids[0]}

def unreview_image(image_id: int, db: typing.Optional[Database] = None) -> dict:
    """Reset an image's review status back to pending."""
    if db is None:
        db = Database()

    now = datetime.utcnow().isoformat()
    db.execute("INSERT OR IGNORE INTO review_status (image_id) VALUES (?)", (image_id,))
    db.execute(
        "UPDATE review_status SET status='pending', reviewed_at=NULL, notes='', updated_at=? "
        "WHERE image_id=?",
        (now, image_id),
    )
    return {"image_id": image_id, "status": "pending"}


def mark_reviewed(image_id: int, status: str = "reviewed",
                  notes: str = "", db: typing.Optional[Database] = None) -> dict:
    """Mark a single image as reviewed or skipped."""
    if db is None:
        db = Database()

    now = datetime.utcnow().isoformat()
    # Atomic: INSERT OR REPLACE avoids TOCTOU race between UPDATE + INSERT
    db.execute(
        """INSERT OR REPLACE INTO review_status
           (image_id, status, has_human_annotation, has_model_prediction,
            human_annotation_count, model_prediction_count, reviewed_at, notes, updated_at)
           VALUES (?, ?, COALESCE((SELECT has_human_annotation FROM review_status WHERE image_id=?), 0),
                   COALESCE((SELECT has_model_prediction FROM review_status WHERE image_id=?), 0),
                   COALESCE((SELECT human_annotation_count FROM review_status WHERE image_id=?), 0),
                   COALESCE((SELECT model_prediction_count FROM review_status WHERE image_id=?), 0),
                   ?, ?, ?)""",
        (image_id, status, image_id, image_id, image_id, image_id, now, notes, now),
    )

    return {"image_id": image_id, "status": status}


def mark_batch_reviewed(image_ids: list[int], status: str = "reviewed",
                        db: typing.Optional[Database] = None) -> dict:
    """Mark multiple images as reviewed."""
    if db is None:
        db = Database()

    now = datetime.utcnow().isoformat()
    for image_id in image_ids:
        db.execute(
            "INSERT OR REPLACE INTO review_status (image_id, status, reviewed_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (image_id, status, now, now),
        )

    return {"updated": len(image_ids)}


def mark_all_as_reviewed(db: typing.Optional[Database] = None) -> dict:
    """Mark all pending images as reviewed."""
    if db is None:
        db = Database()

    now = datetime.utcnow().isoformat()
    db.execute("""
        INSERT OR REPLACE INTO review_status (image_id, status, reviewed_at, updated_at)
        SELECT i.id, 'reviewed', ?, ?
        FROM images i
        LEFT JOIN review_status rs ON i.id = rs.image_id
        WHERE COALESCE(rs.status, 'pending') = 'pending'
    """, (now, now))

    count = db.conn.execute("SELECT changes()").fetchone()[0]
    return {"updated": count}
