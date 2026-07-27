from __future__ import annotations
"""Application configuration."""
import os
from pathlib import Path

# Project root
BASE_DIR = Path(__file__).parent.absolute()

# Data directories
DATA_DIR = BASE_DIR / "data"
IMAGE_DIR = DATA_DIR / "images"
ANNOTATION_DIR = DATA_DIR / "annotations"
PREDICTION_DIR = DATA_DIR / "predictions"
MODEL_DIR = DATA_DIR / "models"
EXPORT_DIR = DATA_DIR / "exports"
CLASSES_FILE = DATA_DIR / "classes.txt"

# Database
DATABASE_PATH = BASE_DIR / "progress.db"

# Supported image extensions
SUPPORTED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp'}

# Prediction defaults
DEFAULT_CONFIDENCE = 0.25
DEFAULT_IOU = 0.45

# Server
HOST = "0.0.0.0"
PORT = 8000

# Default class colors (will cycle)
DEFAULT_COLORS = [
    "#FF3838", "#FF9D97", "#FF701F", "#FFB21D", "#CFD231",
    "#48F90A", "#92CC17", "#3DDB86", "#1A9334", "#00D4BB",
    "#2C99A8", "#00C2FF", "#344593", "#6473FF", "#0018EC",
    "#8438FF", "#B085FF", "#C23DFF", "#FF44FF", "#FF4ECD",
]


def ensure_dirs():
    """Create all required directories."""
    for d in [
        IMAGE_DIR / "train", IMAGE_DIR / "val",
        ANNOTATION_DIR / "train", ANNOTATION_DIR / "val",
        PREDICTION_DIR / "train", PREDICTION_DIR / "val",
        MODEL_DIR, EXPORT_DIR,
    ]:
        d.mkdir(parents=True, exist_ok=True)
