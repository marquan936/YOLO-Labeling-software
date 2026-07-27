from __future__ import annotations
"""Export service for YOLO format dataset."""
import os
import uuid
import shutil
import zipfile
from pathlib import Path

import typing
from database import Database
from config import EXPORT_DIR, IMAGE_DIR, ANNOTATION_DIR, PREDICTION_DIR


def export_dataset(source: str = "all", split: str = "all",
                   db: typing.Optional[Database] = None) -> str:
    """Export annotations as a YOLO format ZIP file.

    Args:
        source: "all" | "reviewed" | "human" | "model"
        split: "train" | "val" | "all"
    Returns:
        task_id for download
    """
    if db is None:
        db = Database()

    conditions = []
    params = []
    joins = ""

    if source == "reviewed":
        conditions.append("rs.status = 'reviewed'")
        joins = "JOIN review_status rs ON i.id = rs.image_id"
    elif source == "human":
        conditions.append("COALESCE(rs.has_human_annotation, 0) = 1")
        joins = "LEFT JOIN review_status rs ON i.id = rs.image_id"
    elif source == "model":
        conditions.append("COALESCE(rs.has_model_prediction, 0) = 1")
        joins = "LEFT JOIN review_status rs ON i.id = rs.image_id"

    if split != "all":
        conditions.append("i.split = ?")
        params.append(split)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    images = db.fetch_all(f"""
        SELECT i.* FROM images i {joins} {where} ORDER BY i.filename
    """, params)

    if not images:
        raise ValueError("No images match the export criteria")

    task_id = str(uuid.uuid4())[:8]
    export_dir = EXPORT_DIR / task_id
    export_dir.mkdir(parents=True, exist_ok=True)

    labels_dir = export_dir / "labels"
    images_dir = export_dir / "images"
    labels_dir.mkdir(exist_ok=True)
    images_dir.mkdir(exist_ok=True)

    for img in images:
        stem = Path(img["filename"]).stem
        # Copy image
        src_img = IMAGE_DIR / img["relative_path"]
        if src_img.exists():
            shutil.copy2(src_img, images_dir / img["filename"])

        # Copy annotations based on source
        if source == "model":
            pred_dir = PREDICTION_DIR / img["split"]
            candidates = sorted(pred_dir.glob(f"{stem}_*.txt"))
            ann_path = candidates[0] if candidates else None
        elif source == "human":
            ann_path = ANNOTATION_DIR / img["split"] / f"{stem}.txt"
        else:
            # "all" or "reviewed": prefer human, fallback to prediction
            ann_path = ANNOTATION_DIR / img["split"] / f"{stem}.txt"
            if not ann_path.exists():
                pred_dir = PREDICTION_DIR / img["split"]
                candidates = sorted(pred_dir.glob(f"{stem}_*.txt"))
                ann_path = candidates[0] if candidates else None

        if ann_path and ann_path.exists():
            shutil.copy2(ann_path, labels_dir / f"{stem}.txt")

    # Generate data.yaml
    classes = db.fetch_all("SELECT name FROM class_definitions ORDER BY idx")
    if classes:
        names_str = ", ".join(f'"{c["name"]}"' for c in classes)
    else:
        names_str = ""

    yaml_content = f"""# YOLO Dataset Config
path: .
train: images
val: images
nc: {len(classes)}
names: [{names_str}]
"""
    with open(export_dir / "data.yaml", 'w') as f:
        f.write(yaml_content)

    # Create ZIP
    zip_path = EXPORT_DIR / f"{task_id}.zip"
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_path in export_dir.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(export_dir))

    # Clean up temp directory
    shutil.rmtree(export_dir)

    # Store task info
    _EXPORT_TASKS = getattr(export_dataset, '_tasks', {})
    _EXPORT_TASKS[task_id] = {
        "zip_path": str(zip_path),
        "file_count": len(images),
    }
    setattr(export_dataset, '_tasks', _EXPORT_TASKS)

    return task_id


def get_export_task(task_id: str) -> typing.Optional[dict]:
    """Get export task info."""
    tasks = getattr(export_dataset, '_tasks', {})
    return tasks.get(task_id)
