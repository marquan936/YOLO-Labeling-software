from __future__ import annotations
"""Annotation file read/write service for YOLO format."""
import os
from pathlib import Path
from datetime import datetime

from database import Database
from config import ANNOTATION_DIR
from utils.yolo_utils import yolo_line_to_dict, dict_to_yolo_line, make_annotation_key


def get_annotations_for_image(image_id: int, db: Database) -> list[dict]:
    """Read human annotations from YOLO .txt file for a given image."""
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        return []

    ann_path = _get_annotation_path(image)
    if not ann_path.exists():
        return []

    annotations = []
    with open(ann_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                ann = yolo_line_to_dict(line)
                if ann:
                    annotations.append(ann)
    return annotations


def save_annotations_for_image(image_id: int, annotations: list[dict],
                               db: Database) -> int:
    """Write human annotations to YOLO .txt file (full replacement)."""
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise ValueError(f"Image {image_id} not found")
    ann_path = _get_annotation_path(image)
    count = len(annotations)

    # If no annotations, remove any existing file and clear DB records
    if count == 0:
        return delete_annotations_for_image(image_id, db)

    os.makedirs(ann_path.parent, exist_ok=True)
    with open(ann_path, 'w') as f:
        for ann in annotations:
            f.write(dict_to_yolo_line(ann) + "\n")
    db.execute("INSERT OR IGNORE INTO review_status (image_id) VALUES (?)", (image_id,))
    existing_status = db.fetch_one(
        "SELECT status FROM review_status WHERE image_id = ?",
        (image_id,),
    )
    status = existing_status["status"] if existing_status else 'pending'
    if count == 0:
        status = 'pending'

    db.execute(
        "UPDATE review_status SET has_human_annotation=?, human_annotation_count=?, status=?, updated_at=? "
        "WHERE image_id=?",
        (1 if count > 0 else 0, count, status, datetime.utcnow().isoformat(), image_id),
    )

    # Track annotation file record
    existing = db.fetch_one(
        "SELECT id FROM annotation_files WHERE image_id=? AND source='human'",
        (image_id,),
    )

    rel_path = _get_relative_path(ann_path)

    if existing:
        db.execute(
            "UPDATE annotation_files SET file_path=?, annotation_count=?, updated_at=? WHERE id=?",
            (rel_path, count, datetime.utcnow().isoformat(), existing["id"]),
        )
    else:
        db.execute(
            "INSERT INTO annotation_files (image_id, file_path, source, annotation_count) "
            "VALUES (?, ?, 'human', ?)",
            (image_id, rel_path, count),
        )

    return count


def merge_annotations(image_id: int, new_annotations: list[dict],
                      db: Database) -> int:
    """Append new annotations, deduplicating by approximate position."""
    existing = get_annotations_for_image(image_id, db)
    existing_keys = {make_annotation_key(a) for a in existing}
    merged = list(existing)

    for ann in new_annotations:
        key = make_annotation_key(ann)
        if key not in existing_keys:
            merged.append(ann)
            existing_keys.add(key)

    return save_annotations_for_image(image_id, merged, db)


def delete_annotations_for_image(image_id: int, db: Database) -> int:
    """Delete human annotations for an image."""
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        return 0

    ann_path = _get_annotation_path(image)
    if ann_path.exists():
        ann_path.unlink()
    # Update review_status: clear human annotation counts and set status to pending
    existing = db.fetch_one("SELECT model_prediction_count FROM review_status WHERE image_id=?", (image_id,))
    model_count = existing["model_prediction_count"] if existing and existing.get("model_prediction_count") is not None else 0
    # If there are no model predictions either, reset status to pending
    new_status = 'pending' if model_count == 0 else None
    if new_status:
        db.execute(
            "UPDATE review_status SET has_human_annotation=0, human_annotation_count=0, status=?, updated_at=? WHERE image_id=?",
            (new_status, datetime.utcnow().isoformat(), image_id),
        )
    else:
        db.execute(
            "UPDATE review_status SET has_human_annotation=0, human_annotation_count=0, updated_at=? WHERE image_id=?",
            (datetime.utcnow().isoformat(), image_id),
        )
    db.execute(
        "DELETE FROM annotation_files WHERE image_id=? AND source='human'",
        (image_id,),
    )
    return 1


def _get_annotation_path(image: dict) -> Path:
    """Build the annotation file path for an image."""
    stem = Path(image["filename"]).stem
    return ANNOTATION_DIR / image["split"] / f"{stem}.txt"


def _get_relative_path(path: Path) -> str:
    """Safely get relative path to project root."""
    try:
        cwd = Path.cwd().resolve()
        if path.is_absolute():
            abs_path = path.resolve()
        else:
            abs_path = (cwd / path).resolve()
        return str(abs_path.relative_to(cwd)).replace("\\", "/")
    except Exception:
        # Fallback
        p = str(path).replace("\\", "/").lstrip("./")
        if not p.startswith("data/"):
            p = f"data/{p.lstrip('/')}"
        return p