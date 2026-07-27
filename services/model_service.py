from __future__ import annotations
"""YOLO model lifecycle management."""
import os
from pathlib import Path
from datetime import datetime
from typing import Optional

from database import Database
from config import MODEL_DIR


# Module-level model cache
_LOADED_MODEL: Optional[dict] = None


def get_loaded_model() -> Optional[dict]:
    """Return the currently loaded model info dict or None."""
    return _LOADED_MODEL


def _detect_device() -> str:
    """Detect the best available device for inference.
    Returns 'cuda' if CUDA GPU is available, otherwise 'cpu'.
    """
    try:
        import torch
        if torch.cuda.is_available():
            device_count = torch.cuda.device_count()
            device_name = torch.cuda.get_device_name(0) if device_count > 0 else "Unknown"
            print(f"[Device] CUDA available: {device_name} ({device_count} GPU(s))")
            return "cuda"
    except ImportError:
        pass
    print("[Device] CUDA not available, falling back to CPU")
    return "cpu"


def get_available_device() -> dict:
    """Get information about available compute devices."""
    info = {"device": "cpu", "cuda_available": False, "gpu_name": None, "gpu_count": 0}
    try:
        import torch
        if torch.cuda.is_available():
            info["cuda_available"] = True
            info["device"] = "cuda"
            info["gpu_count"] = torch.cuda.device_count()
            info["gpu_name"] = torch.cuda.get_device_name(0) if info["gpu_count"] > 0 else None
    except ImportError:
        pass
    return info


def list_models(db: Database) -> list:
    """List all registered models."""
    return db.fetch_all("SELECT * FROM models ORDER BY name")


def list_available_pretrained() -> list:
    """List well-known pre-trained model names available for download."""
    return [
        # YOLOv8
        "yolov8n.pt", "yolov8s.pt", "yolov8m.pt", "yolov8l.pt", "yolov8x.pt",
        "yolov8n-seg.pt", "yolov8s-seg.pt", "yolov8m-seg.pt",
        # YOLOv11
        "yolov11n.pt", "yolov11s.pt", "yolov11m.pt", "yolov11l.pt", "yolov11x.pt",
        # RT-DETR
        "rtdetr-l.pt", "rtdetr-x.pt",
    ]


def load_model(model_id: int, db: Database, device: str = None) -> dict:
    """Load a YOLO model into memory.

    Args:
        model_id: Database ID of the model to load.
        device: Device to use ('cuda', 'cpu', 'auto', or None for auto-detect).
                Defaults to auto-detecting CUDA if available.
    """
    global _LOADED_MODEL

    from ultralytics import YOLO

    model_info = db.fetch_one("SELECT * FROM models WHERE id = ?", (model_id,))
    if not model_info:
        raise ValueError(f"Model {model_id} not found in database")

    filepath = model_info["file_path"]
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Model file not found: {filepath}")

    # Unload existing model first
    if _LOADED_MODEL is not None:
        unload_model(db)

    # Determine device
    if device is None:
        device = _detect_device()

    print(f"[Model] Loading {model_info['name']} on device: {device}")
    model = YOLO(filepath)
    # Move model to the specified device
    if device != "cpu":
        try:
            model.to(device)
        except Exception as e:
            print(f"[Model] Failed to move to {device}: {e}, trying CPU")
            device = "cpu"
            model.to("cpu")

    _LOADED_MODEL = {
        "model": model,
        "info": model_info,
        "device": device,
        "loaded_at": datetime.utcnow(),
    }

    # Update DB
    db.execute("UPDATE models SET is_loaded=0 WHERE is_loaded=1")
    db.execute(
        "UPDATE models SET is_loaded=1, times_used=times_used+1, updated_at=? WHERE id=?",
        (datetime.utcnow().isoformat(), model_id),
    )

    # Get class names
    class_count = len(model.names) if hasattr(model, 'names') and model.names else 80

    return {
        "name": model_info["name"],
        "device": device,
        "class_count": class_count,
        "model_type": model_info.get("model_type", "YOLO"),
    }


def unload_model(db: Database) -> dict:
    """Unload the current model from memory."""
    global _LOADED_MODEL

    if _LOADED_MODEL:
        model_info = _LOADED_MODEL["info"]
        db.execute("UPDATE models SET is_loaded=0 WHERE id=?", (model_info["id"],))
        _LOADED_MODEL = None
        return {"name": model_info["name"], "status": "unloaded"}
    return {"status": "no model loaded"}


def download_model(model_name: str, db: Database) -> dict:
    """Download a pre-trained YOLO model."""
    from ultralytics import YOLO

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    filepath = MODEL_DIR / model_name

    if filepath.exists():
        # Already downloaded, just register in DB
        _register_model(model_name, str(filepath), db)
        return {"name": model_name, "status": "already_exists", "file_path": str(filepath)}

    # Download using ultralytics
    model = YOLO(model_name)  # This triggers auto-download
    # Move to our models directory; check common download locations
    import shutil
    candidates = [
        Path(f"{model_name}"),
        Path.home() / ".ultralytics" / "models" / model_name,
        Path(".ultralytics") / "models" / model_name,
    ]
    actual = None
    for c in candidates:
        if c.exists():
            actual = c
            break
    if actual and actual.resolve() != filepath.resolve():
        shutil.copy2(str(actual), str(filepath))
    elif not filepath.exists():
        # Model may be in memory only; save it
        pass

    _register_model(model_name, str(filepath), db)
    return {"name": model_name, "status": "downloaded", "file_path": str(filepath)}


def register_local_model(filepath: str, db: Database):
    """Register a locally available .pt file."""
    path = Path(filepath)
    if not path.exists():
        raise FileNotFoundError(f"Model file not found: {filepath}")
    if path.suffix not in ('.pt', '.pth'):
        raise ValueError("Model file must be .pt or .pth")
    _register_model(path.stem, str(path.absolute()), db)


def _register_model(name: str, file_path: str, db: Database):
    """Register a model in the database if not already present."""
    existing = db.fetch_one("SELECT id FROM models WHERE name = ?", (name,))
    if existing:
        db.execute(
            "UPDATE models SET file_path=?, updated_at=? WHERE id=?",
            (file_path, datetime.utcnow().isoformat(), existing["id"]),
        )
    else:
        db.execute(
            "INSERT INTO models (name, file_path, model_type) VALUES (?, ?, ?)",
            (name, file_path, "YOLO"),
        )
