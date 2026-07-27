"""Prediction/inference service."""
import os
import uuid
import typing
import traceback
from pathlib import Path
from datetime import datetime

from database import Database
from services.image_service import _find_annotation_file, _find_prediction_file_paths, _count_annotations
from services.model_service import get_loaded_model
from utils.yolo_utils import dict_to_yolo_line
from config import IMAGE_DIR, PREDICTION_DIR


# In-memory task tracking
_PREDICTION_TASKS: dict = {}


def get_task_status(task_id: str) -> typing.Optional[dict]:
    """Get the current status of a prediction task."""
    return _PREDICTION_TASKS.get(task_id)


def predict_single(image_id: int, conf: float = 0.25, iou: float = 0.45,
                   db: typing.Optional[Database] = None,
                   operation: typing.Optional[str] = None) -> dict:
    """Run inference on a single image. Returns detections.

    Args:
        operation: If 'append', merge predictions into human annotations.
    """
    model_info = get_loaded_model()
    if not model_info:
        raise RuntimeError("未加载模型，请先在「模型」面板中下载并加载一个模型")

    if db is None:
        db = Database()

    model = model_info["model"]
    model_name = model_info["info"]["name"]
    device = model_info.get("device", "cpu")

    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise ValueError(f"图片 {image_id} 不存在，请先扫描图片目录")

    # Use absolute path from config
    image_path = str(IMAGE_DIR / image["relative_path"])

    if not os.path.exists(image_path):
        raise FileNotFoundError(
            f"图片文件不存在: {image_path}\n"
            f"请确保图片文件位于 data/images/{image['relative_path']}"
        )

    # Run inference on the loaded device (GPU if available)
    results = model.predict(
        source=image_path,
        conf=conf,
        iou=iou,
        device=device,
        verbose=False,
    )

    detections = _parse_results(results)
    _save_predictions(image, model_name, detections, db)

    # Merge into human annotations if in append mode
    if operation == "append" and detections:
        from services.annotation_service import merge_annotations
        merge_annotations(image_id, detections, db)

    return {
        "image_id": image_id,
        "predictions": detections,
        "model": model_name,
        "count": len(detections),
        "image_path": image_path,
    }


def predict_batch(image_ids: list, conf: float = 0.25, iou: float = 0.45,
                  operation: str = "overwrite") -> str:
    """Start a batch prediction task. Returns task_id."""
    model_info = get_loaded_model()
    if not model_info:
        raise RuntimeError("未加载模型，请先在「模型」面板中下载并加载一个模型")

    if not image_ids:
        raise ValueError("没有可预测的图片。请先在 data/images/ 中放置图片并点击「扫描」")

    task_id = str(uuid.uuid4())[:8]
    _PREDICTION_TASKS[task_id] = {
        "id": task_id,
        "model_name": model_info["info"]["name"],
        "total": len(image_ids),
        "processed": 0,
        "status": "running",
        "operation": operation,
        "errors": [],
    }

    db = Database()
    db.execute(
        "INSERT INTO prediction_tasks (id, model_name, total_images) VALUES (?, ?, ?)",
        (task_id, model_info["info"]["name"], len(image_ids)),
    )

    # Use a sync approach instead of asyncio.create_task for reliability
    import threading
    thread = threading.Thread(
        target=_process_batch_sync,
        args=(task_id, image_ids, conf, iou, operation),
        daemon=True,
    )
    thread.start()

    return task_id


def predict_unannotated(conf: float = 0.25, iou: float = 0.45,
                        operation: str = "overwrite") -> str:
    """Predict all images that don't have any labels (human or model)."""
    if not get_loaded_model():
        raise RuntimeError("未加载模型，请先在「模型」面板中下载并加载一个模型")

    db = Database()
    images = db.fetch_all("SELECT id, filename, split FROM images ORDER BY filename")
    image_ids = []
    for img in images:
        human_ann = _find_annotation_file(img)
        model_files = _find_prediction_file_paths(img)
        human_count = _count_annotations(human_ann) if human_ann.exists() else 0
        model_count = 0
        for pred_file in model_files:
            model_count = max(model_count, _count_annotations(pred_file))

        if human_count == 0 and model_count == 0:
            image_ids.append(img["id"])

    if not image_ids:
        raise ValueError(
            "所有图片都已有标注，无需预测。\n"
            "如需预测已有标注的图片，请使用「预测当前图片」功能。"
        )

    return predict_batch(image_ids, conf, iou, operation)


def _process_batch_sync(task_id: str, image_ids: list, conf: float,
                        iou: float, operation: str):
    """Synchronous batch processing in a background thread."""
    db = Database()
    total = len(image_ids)

    for idx, image_id in enumerate(image_ids):
        try:
            predict_single(image_id, conf, iou, db, operation=operation)
        except Exception as e:
            err_msg = f"图片 {image_id}: {str(e)}"
            _PREDICTION_TASKS[task_id].setdefault("errors", []).append(err_msg)
        finally:
            _PREDICTION_TASKS[task_id]["processed"] = idx + 1

        if (idx + 1) % 5 == 0 or idx == total - 1:
            try:
                db.execute(
                    "UPDATE prediction_tasks SET processed=? WHERE id=?",
                    (idx + 1, task_id),
                )
            except Exception:
                pass

    _PREDICTION_TASKS[task_id]["status"] = "completed"
    try:
        db.execute(
            "UPDATE prediction_tasks SET status='completed', processed=?, completed_at=? WHERE id=?",
            (total, datetime.utcnow().isoformat(), task_id),
        )
    except Exception:
        pass


def _parse_results(results) -> list:
    """Parse ultralytics results into annotation dicts."""
    detections = []
    result = results[0]
    if result.boxes is not None and len(result.boxes) > 0:
        boxes = result.boxes.xywhn.cpu().numpy()
        classes = result.boxes.cls.cpu().numpy().astype(int)
        confidences = result.boxes.conf.cpu().numpy()
        for i in range(len(boxes)):
            detections.append({
                "class_id": int(classes[i]),
                "x_center": float(boxes[i][0]),
                "y_center": float(boxes[i][1]),
                "width": float(boxes[i][2]),
                "height": float(boxes[i][3]),
                "confidence": float(confidences[i]),
            })
    return detections


def _save_predictions(image: dict, model_name: str, detections: list,
                      db: Database):
    """Save model predictions to file and update DB."""
    stem = Path(image["filename"]).stem
    pred_path = PREDICTION_DIR / image["split"] / f"{stem}_{model_name}.txt"
    os.makedirs(pred_path.parent, exist_ok=True)

    with open(pred_path, 'w') as f:
        for det in detections:
            f.write(dict_to_yolo_line(det) + "\n")

    db.execute(
        "INSERT OR IGNORE INTO review_status (image_id) VALUES (?)",
        (image["id"],),
    )
    db.execute(
        "UPDATE review_status SET has_model_prediction=1, model_prediction_count=?, "
        "updated_at=? WHERE image_id=?",
        (len(detections), datetime.utcnow().isoformat(), image["id"]),
    )

    # Track annotation file
    rel_path = str(pred_path).replace("\\", "/")
    existing = db.fetch_one(
        "SELECT id FROM annotation_files WHERE image_id=? AND source='model' AND model_name=?",
        (image["id"], model_name),
    )
    if existing:
        db.execute(
            "UPDATE annotation_files SET file_path=?, annotation_count=?, updated_at=? WHERE id=?",
            (rel_path, len(detections), datetime.utcnow().isoformat(), existing["id"]),
        )
    else:
        db.execute(
            "INSERT INTO annotation_files (image_id, file_path, source, model_name, annotation_count) "
            "VALUES (?, ?, 'model', ?, ?)",
            (image["id"], rel_path, model_name, len(detections)),
        )


def _find_prediction_path(image: dict, model_name: str = "") -> Path:
    """Find the existing prediction file for an image, or determine the path for a new one."""
    stem = Path(image["filename"]).stem
    pred_dir = PREDICTION_DIR / image["split"]

    if model_name:
        return pred_dir / f"{stem}_{model_name}.txt"

    # Try to find an existing prediction file
    if pred_dir.exists():
        candidates = sorted(pred_dir.glob(f"{stem}_*.txt"))
        if candidates:
            return candidates[0]

    # Fallback: use first existing prediction file if any
    if pred_dir.exists():
        candidates = sorted(pred_dir.glob(f"{stem}_*.txt"))
        if candidates:
            return candidates[0]

    return pred_dir / f"{stem}_model.txt"


def save_predictions_for_image(image_id: int, predictions: list,
                               db: typing.Optional[Database] = None) -> int:
    """Overwrite model predictions file for an image (e.g. after manual edits)."""
    if db is None:
        db = Database()

    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise ValueError(f"Image {image_id} not found")

    model_info = get_loaded_model()
    model_name = model_info["info"]["name"] if model_info else ""

    pred_path = _find_prediction_path(image, model_name)
    os.makedirs(pred_path.parent, exist_ok=True)

    with open(pred_path, 'w') as f:
        for det in predictions:
            f.write(dict_to_yolo_line(det) + "\n")

    count = len(predictions)
    db.execute(
        "UPDATE review_status SET has_model_prediction=?, model_prediction_count=?, updated_at=? WHERE image_id=?",
        (1 if count > 0 else 0, count, datetime.utcnow().isoformat(), image_id),
    )

    return count


def get_predictions_for_image(image_id: int, model_name: str = "",
                              db: typing.Optional[Database] = None) -> list:
    """Read model predictions from file for an image."""
    if db is None:
        db = Database()

    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        return []

    if not model_name:
        model_info = get_loaded_model()
        if model_info:
            model_name = model_info["info"]["name"]
        else:
            stem = Path(image["filename"]).stem
            pred_dir = PREDICTION_DIR / image["split"]
            candidates = list(pred_dir.glob(f"{stem}_*.txt"))
            if candidates:
                return _read_prediction_file(candidates[0])
            return []

    stem = Path(image["filename"]).stem
    pred_path = PREDICTION_DIR / image["split"] / f"{stem}_{model_name}.txt"
    return _read_prediction_file(pred_path)


def _read_prediction_file(filepath: Path) -> list:
    """Read a prediction YOLO file."""
    if not filepath.exists():
        return []

    from utils.yolo_utils import yolo_line_to_dict
    detections = []
    with open(filepath, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                ann = yolo_line_to_dict(line)
                if ann:
                    detections.append(ann)
    return detections
