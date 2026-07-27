"""Prediction/inference API routes."""
from __future__ import annotations
import os
import uuid
import threading
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from database import Database
from services import prediction_service, model_service

router = APIRouter(prefix="/api/v1", tags=["predictions"])


class BatchPredictRequest(BaseModel):
    image_ids: list[int]
    confidence_threshold: float = 0.25
    iou_threshold: float = 0.45
    operation: str = "overwrite"


class UnannotatedPredictRequest(BaseModel):
    confidence_threshold: float = 0.25
    iou_threshold: float = 0.45
    operation: str = "overwrite"

    class Config:
        extra = "ignore"  # 允许多余字段


class FolderPredictRequest(BaseModel):
    folder_path: str
    confidence_threshold: float = 0.25
    iou_threshold: float = 0.45


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


# ── Static routes MUST come before dynamic /{image_id} routes ──────────────

@router.post("/predict/batch")
def predict_batch(body: BatchPredictRequest):
    if not model_service.get_loaded_model():
        raise HTTPException(400, "未加载模型。请先在「模型」面板中下载并加载一个 YOLO 模型")

    try:
        task_id = prediction_service.predict_batch(
            body.image_ids, body.confidence_threshold, body.iou_threshold, body.operation
        )
        return {"task_id": task_id, "total": len(body.image_ids)}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/predict/unannotated")
def predict_unannotated(body: UnannotatedPredictRequest = None):
    """支持空请求体，使用默认参数"""
    if body is None:
        body = UnannotatedPredictRequest()

    if not model_service.get_loaded_model():
        raise HTTPException(400, "未加载模型。请先在「模型」面板中下载并加载一个 YOLO 模型")

    try:
        task_id = prediction_service.predict_unannotated(
            body.confidence_threshold, body.iou_threshold, body.operation
        )
        task = prediction_service.get_task_status(task_id)
        return {"task_id": task_id, "total": task["total"] if task else 0}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"预测失败: {str(e)}")


@router.post("/predict/folder")
def predict_folder(body: FolderPredictRequest):
    import os
    from config import SUPPORTED_EXTENSIONS, IMAGE_DIR

    if not model_service.get_loaded_model():
        raise HTTPException(400, "未加载模型。请先在「模型」面板中加载一个模型")

    folder = body.folder_path.strip()
    if not folder or not os.path.isdir(folder):
        raise HTTPException(400, f"文件夹路径不存在: {folder}")

    # Find all image files
    image_files = []
    for root, dirs, files in os.walk(folder):
        for f in files:
            if os.path.splitext(f)[1].lower() in SUPPORTED_EXTENSIONS:
                image_files.append(os.path.join(root, f))

    if not image_files:
        raise HTTPException(400, f"文件夹中没有找到图片文件: {folder}")

    # Register images in DB and run predictions
    db = get_db()
    model_info = model_service.get_loaded_model()
    model_name = model_info["info"]["name"]

    # Determine split from folder name
    folder_name = os.path.basename(folder.rstrip('/\\'))
    split = 'val' if 'val' in folder_name.lower() else 'train'

    task_id = str(uuid.uuid4())[:8]
    prediction_service._PREDICTION_TASKS[task_id] = {
        "id": task_id, "model_name": model_name,
        "total": len(image_files), "processed": 0,
        "status": "running", "operation": "folder_predict",
        "errors": [],
    }

    import threading
    def _process_folder():
        processed = 0
        for img_path in image_files:
            try:
                # Register image in DB if not exists
                from PIL import Image
                rel = f"{split}/{os.path.basename(img_path)}"
                existing = db.fetch_one("SELECT id FROM images WHERE relative_path=?", (rel,))
                if not existing:
                    with Image.open(img_path) as pil_img:
                        w, h = pil_img.size
                    db.execute(
                        "INSERT INTO images (filename, relative_path, split, width, height, file_size) VALUES (?,?,?,?,?,?)",
                        (os.path.basename(img_path), rel, split, w, h, os.path.getsize(img_path)),
                    )
                    img_id = db.last_insert_rowid()
                    db.execute("INSERT OR IGNORE INTO review_status (image_id) VALUES (?)", (img_id,))
                else:
                    img_id = existing["id"]

                # Copy image to our data directory
                dest = IMAGE_DIR / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    import shutil
                    shutil.copy2(img_path, dest)

                # Run prediction
                prediction_service.predict_single(img_id, body.confidence_threshold, body.iou_threshold, db)
                processed += 1
                prediction_service._PREDICTION_TASKS[task_id]["processed"] = processed
            except Exception as e:
                prediction_service._PREDICTION_TASKS[task_id].setdefault("errors", []).append(
                    f"{os.path.basename(img_path)}: {str(e)}"
                )
                processed += 1

        prediction_service._PREDICTION_TASKS[task_id]["status"] = "completed"

    thread = threading.Thread(target=_process_folder, daemon=True)
    thread.start()

    return {
        "task_id": task_id,
        "total": len(image_files),
        "folder": folder,
        "split": split,
        "message": f"开始处理 {len(image_files)} 张图片，图片将复制到 data/images/{split}/",
    }


# ── Dynamic path-parameter routes come AFTER static routes ──────────────────

@router.post("/predict/{image_id}")
def predict_single(image_id: int,
                   confidence: float = Query(0.25, ge=0.0, le=1.0),
                   iou: float = Query(0.45, ge=0.0, le=1.0),
                   operation: str = Query("overwrite", pattern="^(overwrite|append)$")):
    if not model_service.get_loaded_model():
        raise HTTPException(400, "No model loaded. Load a model first.")

    try:
        result = prediction_service.predict_single(image_id, confidence, iou, get_db(), operation=operation)
        return result
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/predict/task/{task_id}")
def get_task_status(task_id: str):
    task = prediction_service.get_task_status(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    task["progress"] = task.get("processed", 0) / max(task.get("total", 1), 1)
    return task


class PredictionUpdate(BaseModel):
    predictions: list


@router.get("/predictions/{image_id}")
def get_predictions(image_id: int, model_name: str = ""):
    db = get_db()
    predictions = prediction_service.get_predictions_for_image(image_id, model_name, db)
    return {
        "image_id": image_id,
        "predictions": predictions,
        "source": "model",
        "count": len(predictions),
    }


@router.put("/predictions/{image_id}")
def save_predictions(image_id: int, body: PredictionUpdate):
    """Overwrite model predictions for an image (e.g. after manual deletion)."""
    db = get_db()
    count = prediction_service.save_predictions_for_image(image_id, body.predictions, db)
    return {"image_id": image_id, "saved": count}
