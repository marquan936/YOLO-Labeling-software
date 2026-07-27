from __future__ import annotations
"""Image file scanning and metadata service."""
import os
import hashlib
from pathlib import Path
from datetime import datetime
from PIL import Image

from config import IMAGE_DIR, ANNOTATION_DIR, PREDICTION_DIR, SUPPORTED_EXTENSIONS
from database import Database


def _hash_file(filepath: str, chunk_size: int = 8192) -> str:
    """Compute SHA256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(chunk_size):
            h.update(chunk)
    return h.hexdigest()


def scan_images_directory(db: Database) -> dict:
    """Scan data/images/{train,val} for images and register in DB."""
    added = 0
    updated = 0

    for split_dir in ['train', 'val']:
        split_path = IMAGE_DIR / split_dir
        if not split_path.exists():
            continue

        for file_path in split_path.rglob("*"):
            if not file_path.is_file():
                continue
            if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue

            rel = f"{split_dir}/{file_path.relative_to(split_path).as_posix()}"

            existing = db.fetch_one(
                "SELECT id, file_size FROM images WHERE relative_path = ?", (rel,)
            )

            file_size = file_path.stat().st_size

            if existing:
                if existing["file_size"] != file_size:
                    try:
                        with Image.open(file_path) as img:
                            w, h = img.size
                        db.execute(
                            "UPDATE images SET width=?, height=?, file_size=?, updated_at=? WHERE id=?",
                            (w, h, file_size, datetime.utcnow().isoformat(), existing["id"]),
                        )
                        updated += 1
                    except Exception:
                        pass
            else:
                try:
                    with Image.open(file_path) as img:
                        w, h = img.size
                    db.execute(
                        "INSERT INTO images (filename, relative_path, split, width, height, file_size) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (file_path.name, rel, split_dir, w, h, file_size),
                    )
                    added += 1
                except Exception:
                    continue

            # Ensure review_status row exists
            img_id = existing["id"] if existing else db.last_insert_rowid()
            db.execute("INSERT OR IGNORE INTO review_status (image_id) VALUES (?)", (img_id,))

            # Update human annotation status from actual file content
            stem = file_path.stem
            human_ann = ANNOTATION_DIR / split_dir / f"{stem}.txt"
            if human_ann.exists():
                ann_count = _count_annotations(human_ann)
                db.execute(
                    "UPDATE review_status SET has_human_annotation=?, human_annotation_count=?, updated_at=? WHERE image_id=?",
                    (1 if ann_count > 0 else 0, ann_count, datetime.utcnow().isoformat(), img_id),
                )
            else:
                db.execute(
                    "UPDATE review_status SET has_human_annotation=0, human_annotation_count=0, updated_at=? WHERE image_id=?",
                    (datetime.utcnow().isoformat(), img_id),
                )

            # Update model prediction status from existing prediction files
            model_files = _find_prediction_files(stem, split_dir)
            if model_files:
                max_pred_count = 0
                for pred_file in model_files:
                    pred_count = _count_annotations(pred_file)
                    max_pred_count = max(max_pred_count, pred_count)
                db.execute(
                    "UPDATE review_status SET has_model_prediction=?, model_prediction_count=?, updated_at=? WHERE image_id=?",
                    (1 if max_pred_count > 0 else 0, max_pred_count, datetime.utcnow().isoformat(), img_id),
                )
            else:
                db.execute(
                    "UPDATE review_status SET has_model_prediction=0, model_prediction_count=0, updated_at=? WHERE image_id=?",
                    (datetime.utcnow().isoformat(), img_id),
                )

    return {"added": added, "updated": updated}


def _count_annotations(filepath: Path) -> int:
    """Count non-empty, non-comment lines in a YOLO annotation file."""
    count = 0
    try:
        with open(filepath, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    parts = line.split()
                    if len(parts) >= 5:
                        count += 1
    except Exception:
        pass
    return count


def _find_prediction_files(stem: str, split_dir: str) -> list[Path]:
    """Return prediction files matching an image stem in the prediction directory."""
    pred_dir = PREDICTION_DIR / split_dir
    if not pred_dir.exists():
        return []
    return list(pred_dir.glob(f"{stem}_*.txt"))


def _find_annotation_file(image: dict) -> Path:
    stem = Path(image["filename"]).stem
    return ANNOTATION_DIR / image["split"] / f"{stem}.txt"


def _find_prediction_file_paths(image: dict) -> list[Path]:
    stem = Path(image["filename"]).stem
    return _find_prediction_files(stem, image["split"])


def update_review_status_from_disk(db: Database):
    """Refresh review_status counts from actual annotation and prediction files."""
    images = db.fetch_all("SELECT id, filename, split FROM images")
    for image in images:
        update_review_status_for_image(image, db)


def update_review_status_for_image(image: dict, db: Database):
    """Refresh a single image's review status based on actual label/prediction files."""
    human_ann = _find_annotation_file(image)
    human_count = _count_annotations(human_ann) if human_ann.exists() else 0
    model_files = _find_prediction_file_paths(image)
    model_count = 0
    for pred_file in model_files:
        model_count = max(model_count, _count_annotations(pred_file))

    existing = db.fetch_one("SELECT status FROM review_status WHERE image_id = ?", (image["id"],))
    # Preserve any existing manual review status (e.g. 'reviewed' or 'skipped').
    # Only default to 'pending' when no review_status row exists.
    status = existing["status"] if existing and existing.get("status") is not None else 'pending'

    db.execute("INSERT OR IGNORE INTO review_status (image_id) VALUES (?)", (image["id"],))
    db.execute(
        "UPDATE review_status SET has_human_annotation=?, human_annotation_count=?, has_model_prediction=?, model_prediction_count=?, status=?, updated_at=? WHERE image_id=?",
        (1 if human_count > 0 else 0, human_count, 1 if model_count > 0 else 0, model_count, status, datetime.utcnow().isoformat(), image["id"]),
    )


def count_unannotated_images(db: Database) -> int:
    """Count images with neither valid human annotation nor model prediction content."""
    images = db.fetch_all("SELECT id, filename, split FROM images")
    count = 0
    for image in images:
        human_ann = _find_annotation_file(image)
        human_count = _count_annotations(human_ann) if human_ann.exists() else 0
        if human_count > 0:
            continue
        model_files = _find_prediction_file_paths(image)
        model_count = 0
        for pred_file in model_files:
            model_count = max(model_count, _count_annotations(pred_file))
        if model_count == 0:
            count += 1
    return count


def get_image_path(image: dict) -> str:
    """Get the absolute filesystem path for an image."""
    return str(IMAGE_DIR / image["relative_path"])
