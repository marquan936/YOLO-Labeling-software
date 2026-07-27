from __future__ import annotations
"""Comparison view API routes."""
from fastapi import APIRouter, HTTPException, Query

from database import Database
from services.annotation_service import get_annotations_for_image
from services.prediction_service import get_predictions_for_image
from utils.yolo_utils import yolo_to_pixel, compute_iou

router = APIRouter(prefix="/api/v1/comparison", tags=["comparison"])


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.get("/{image_id}")
def get_comparison(image_id: int, model_name: str = "",
                   iou_threshold: float = Query(0.5, ge=0.0, le=1.0)):
    db = get_db()
    image = db.fetch_one("SELECT * FROM images WHERE id = ?", (image_id,))
    if not image:
        raise HTTPException(404, "Image not found")

    human = get_annotations_for_image(image_id, db)
    model = get_predictions_for_image(image_id, model_name, db)

    # Compute matching statistics
    img_w, img_h = image["width"], image["height"]
    human_pixel = [yolo_to_pixel(a, img_w, img_h) for a in human]
    model_pixel = [yolo_to_pixel(p, img_w, img_h) for p in model]

    matches = []
    unmatched_h = list(range(len(human)))
    unmatched_m = list(range(len(model)))

    for hi, hbox in enumerate(human_pixel):
        best_iou = iou_threshold
        best_mi = -1
        for mi, mbox in enumerate(model_pixel):
            if mi not in unmatched_m:
                continue
            iou_val = compute_iou(hbox, mbox)
            if iou_val > best_iou:
                best_iou = iou_val
                best_mi = mi
        if best_mi >= 0:
            matches.append({
                "human_idx": hi,
                "model_idx": best_mi,
                "iou": round(best_iou, 4),
            })
            unmatched_h.remove(hi)
            unmatched_m.remove(best_mi)

    return {
        "image_id": image_id,
        "image": image,
        "human": human,
        "model": model,
        "matches": matches,
        "unmatched_human": unmatched_h,
        "unmatched_model": unmatched_m,
        "stats": {
            "total_human": len(human),
            "total_model": len(model),
            "matched": len(matches),
            "unmatched_human": len(unmatched_h),
            "unmatched_model": len(unmatched_m),
        },
    }
