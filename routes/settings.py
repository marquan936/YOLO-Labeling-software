from __future__ import annotations
"""Application settings API routes."""
from fastapi import APIRouter
from pydantic import BaseModel
from database import Database
import json
import copy

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


def _deep_merge(defaults: dict, overrides: dict) -> dict:
    """Recursively merge overrides into defaults, preserving nested keys."""
    result = copy.deepcopy(defaults)
    for key, value in overrides.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


DEFAULT_SETTINGS = {
    "theme": "dark",
    "theme_colors": {
        "accent": "#4fc3f7",
        "bg_primary": "#1a1a2e",
        "bg_secondary": "#16213e",
        "text_primary": "#e0e0e0",
    },
    "annotation": {
        "default_opacity": 0.3,
        "box_border_width": 2,
        "min_box_size": 3,
        "show_labels": True,
        "label_font_size": 13,
        "auto_show_label_dropdown": True,
    },
    "auto_save": {
        "enabled": True,
        "interval_seconds": 30,
    },
    "display": {
        "show_grid": True,
        "grid_size": 20,
        "show_crosshair": True,
        "original_image_toggle": False,
    },
    "shortcuts": {
        "tool_select": "s",
        "tool_draw_rect": "r",
        "tool_draw_polygon": "p",
        "tool_pan": "h",
        "delete_box": "delete",
        "cancel_drawing": "escape",
        "save": "ctrl+s",
        "next_image": "arrowright",
        "prev_image": "arrowleft",
        "toggle_original": "`",
    },
    "polygon": {
        "default_opacity": 0.35,
        "border_width": 2,
        "vertex_radius": 4,
        "close_tolerance": 8,
    },
}


def get_db() -> Database:
    from app import get_application_db
    return get_application_db()


@router.get("")
def get_settings():
    db = get_db()
    row = db.fetch_one("SELECT value FROM settings WHERE key='app'")
    if row:
        try:
            saved = json.loads(row["value"])
            # Merge with defaults for new fields
            merged = _deep_merge(DEFAULT_SETTINGS, saved)
            return merged
        except Exception:
            pass
    return DEFAULT_SETTINGS


class SettingsUpdate(BaseModel):
    settings: dict


@router.put("")
def update_settings(body: SettingsUpdate):
    db = get_db()
    # Ensure table exists
    db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    value = json.dumps(body.settings, ensure_ascii=False)
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?)",
        (value,),
    )
    return {"saved": True}


@router.get("/themes")
def list_themes():
    return {
        "themes": [
            {
                "name": "暗夜蓝 (默认)",
                "id": "dark",
                "colors": {
                    "accent": "#4fc3f7", "bg_primary": "#1a1a2e",
                    "bg_secondary": "#16213e", "bg_tertiary": "#0f3460",
                    "bg_surface": "#1f2b47", "text_primary": "#e0e0e0",
                    "text_secondary": "#a0a0b0", "border": "#2a3a5e",
                    "success": "#66bb6a", "warning": "#ffa726", "danger": "#ef5350",
                }
            },
            {
                "name": "深黑金",
                "id": "dark_gold",
                "colors": {
                    "accent": "#ffd700", "bg_primary": "#0d0d0d",
                    "bg_secondary": "#1a1a1a", "bg_tertiary": "#2d2d2d",
                    "bg_surface": "#252525", "text_primary": "#f0f0f0",
                    "text_secondary": "#b0b0b0", "border": "#404040",
                    "success": "#4caf50", "warning": "#ff9800", "danger": "#f44336",
                }
            },
            {
                "name": "海洋绿",
                "id": "ocean",
                "colors": {
                    "accent": "#26c6da", "bg_primary": "#0a1929",
                    "bg_secondary": "#0d2137", "bg_tertiary": "#0f3460",
                    "bg_surface": "#132f4c", "text_primary": "#e3f2fd",
                    "text_secondary": "#90caf9", "border": "#1a4a6e",
                    "success": "#69f0ae", "warning": "#ffab40", "danger": "#ff5252",
                }
            },
            {
                "name": "淡雅白",
                "id": "light",
                "colors": {
                    "accent": "#1976d2", "bg_primary": "#f5f5f5",
                    "bg_secondary": "#ffffff", "bg_tertiary": "#e3f2fd",
                    "bg_surface": "#fafafa", "text_primary": "#212121",
                    "text_secondary": "#616161", "border": "#e0e0e0",
                    "success": "#2e7d32", "warning": "#f57c00", "danger": "#c62828",
                }
            },
            {
                "name": "紫罗兰",
                "id": "violet",
                "colors": {
                    "accent": "#ce93d8", "bg_primary": "#12081a",
                    "bg_secondary": "#1a0d26", "bg_tertiary": "#2d1240",
                    "bg_surface": "#251435", "text_primary": "#f3e5f5",
                    "text_secondary": "#ce93d8", "border": "#4a1a6e",
                    "success": "#a5d6a7", "warning": "#ffcc80", "danger": "#ef9a9a",
                }
            },
        ]
    }
