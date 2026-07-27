from __future__ import annotations
"""YOLO format conversion utilities.

Supports two YOLO formats:
  - BBox:  "class_id x_center y_center width height [confidence]"
  - Polygon (segmentation): "class_id x1 y1 x2 y2 ... xn yn [confidence]"
All values are normalized to [0, 1] relative to image dimensions.
"""

from typing import Optional, Union


def yolo_line_to_dict(line: str) -> Optional[dict]:
    """Parse a single YOLO format line into a dict (auto-detect bbox vs polygon)."""
    parts = line.strip().split()
    if len(parts) < 5:
        return None

    cls_id = int(parts[0])
    coords = [float(x) for x in parts[1:]]

    # Check for confidence (last element if odd count after removing class_id)
    has_conf = False
    confidence = None
    data_parts = coords[:]  # copy
    if len(data_parts) == 5:  # bbox with confidence
        has_conf = True
        confidence = data_parts[4]
        data_parts = data_parts[:4]
    elif len(data_parts) == 4:  # bbox without confidence
        pass
    elif len(data_parts) % 2 == 1 and len(data_parts) > 5:  # polygon with confidence (odd count)
        has_conf = True
        confidence = data_parts[-1]
        data_parts = data_parts[:-1]

    if len(data_parts) == 4:
        # BBox format
        return {
            "type": "bbox",
            "class_id": cls_id,
            "x_center": data_parts[0],
            "y_center": data_parts[1],
            "width": data_parts[2],
            "height": data_parts[3],
            "confidence": confidence,
        }
    elif len(data_parts) >= 6 and len(data_parts) % 2 == 0:
        # Polygon format: pairs of (x, y) normalized
        points = []
        for i in range(0, len(data_parts), 2):
            points.append({"x": data_parts[i], "y": data_parts[i + 1]})
        return {
            "type": "polygon",
            "class_id": cls_id,
            "points": points,
            "confidence": confidence,
        }
    return None


def dict_to_yolo_line(ann: dict) -> str:
    """Convert annotation dict to YOLO format string."""
    parts = [str(ann["class_id"])]
    ann_type = ann.get("type", "bbox")

    if ann_type == "polygon":
        pts = ann.get("points", [])
        for p in pts:
            parts.append(f"{p['x']:.6f}")
            parts.append(f"{p['y']:.6f}")
    else:
        # bbox
        parts.append(f"{ann['x_center']:.6f}")
        parts.append(f"{ann['y_center']:.6f}")
        parts.append(f"{ann['width']:.6f}")
        parts.append(f"{ann['height']:.6f}")

    if ann.get("confidence") is not None:
        parts.append(f"{ann['confidence']:.6f}")
    return " ".join(parts)


def pixel_to_yolo(x1: float, y1: float, x2: float, y2: float,
                  img_w: int, img_h: int) -> dict:
    """Convert pixel bounding box to YOLO normalized format."""
    x1, x2 = min(x1, x2), max(x1, x2)
    y1, y2 = min(y1, y2), max(y1, y2)
    box_w = x2 - x1
    box_h = y2 - y1
    return {
        "type": "bbox",
        "x_center": max(0.0, min(1.0, (x1 + x2) / 2.0 / img_w)),
        "y_center": max(0.0, min(1.0, (y1 + y2) / 2.0 / img_h)),
        "width": max(0.0, min(1.0, box_w / img_w)),
        "height": max(0.0, min(1.0, box_h / img_h)),
    }


def polygon_pixel_to_yolo(points_px: list, img_w: int, img_h: int) -> dict:
    """Convert pixel-coordinate polygon vertices to YOLO normalized polygon."""
    norm_pts = []
    for pt in points_px:
        norm_pts.append({
            "x": max(0.0, min(1.0, pt["x"] / img_w)),
            "y": max(0.0, min(1.0, pt["y"] / img_h)),
        })
    return {"type": "polygon", "points": norm_pts}


def yolo_to_pixel(ann: dict, img_w: int, img_h: int) -> dict:
    """Convert YOLO normalized annotation to pixel coordinates."""
    if ann.get("type") == "polygon":
        pts_px = []
        for p in ann.get("points", []):
            pts_px.append({"x": p["x"] * img_w, "y": p["y"] * img_h})
        # Compute bounding box from points
        xs = [p["x"] for p in pts_px]
        ys = [p["y"] for p in pts_px]
        return {
            "type": "polygon",
            "points": pts_px,
            "x1": min(xs), "y1": min(ys),
            "x2": max(xs), "y2": max(ys),
        }

    # bbox
    xc = ann["x_center"] * img_w
    yc = ann["y_center"] * img_h
    w = ann["width"] * img_w
    h = ann["height"] * img_h
    return {
        "type": "bbox",
        "x1": xc - w / 2, "y1": yc - h / 2,
        "x2": xc + w / 2, "y2": yc + h / 2,
    }


def get_bbox_from_annotation(ann: dict, img_w: int, img_h: int) -> tuple:
    """Get bounding box (x1,y1,x2,y2) in pixel coords from any annotation type."""
    px = yolo_to_pixel(ann, img_w, img_h)
    return (px["x1"], px["y1"], px["x2"], px["y2"])


def compute_iou(box_a: dict, box_b: dict) -> float:
    """Compute IoU between two bounding boxes in pixel coordinates."""
    xa = max(box_a["x1"], box_b["x1"])
    ya = max(box_a["y1"], box_b["y1"])
    xb = min(box_a["x2"], box_b["x2"])
    yb = min(box_a["y2"], box_b["y2"])
    inter_w = max(0, xb - xa)
    inter_h = max(0, yb - ya)
    intersection = inter_w * inter_h
    area_a = (box_a["x2"] - box_a["x1"]) * (box_a["y2"] - box_a["y1"])
    area_b = (box_b["x2"] - box_b["x1"]) * (box_b["y2"] - box_b["y1"])
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def make_annotation_key(ann: dict) -> tuple:
    """Create a dedup key from an annotation."""
    if ann.get("type") == "polygon":
        pts = tuple((round(p["x"], 4), round(p["y"], 4)) for p in ann.get("points", []))
        return (ann["class_id"],) + pts
    return (
        ann["class_id"],
        round(ann.get("x_center", 0), 4),
        round(ann.get("y_center", 0), 4),
        round(ann.get("width", 0), 4),
        round(ann.get("height", 0), 4),
    )
