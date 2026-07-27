from __future__ import annotations
"""
Auto-Annotator — YOLO-based image annotation tool.
FastAPI backend with HTML/JS frontend.
"""
import sys
import threading
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
import asyncio

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from config import ensure_dirs, HOST, PORT
from database import Database

# ─── Application database singleton ───────────────────────────────────────
_app_db: Optional[Database] = None
_app_db_lock = threading.Lock()


def get_application_db() -> Database:
    global _app_db
    if _app_db is None:
        with _app_db_lock:
            if _app_db is None:
                _app_db = Database()
                _app_db.initialize()
    return _app_db


# ─── Lifespan ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print("[Auto-Annotator] Starting up...")
    # Register an asyncio exception handler to quietly ignore ConnectionResetError
    # arising from clients force-closing connections on Windows (WinError 10054).
    def _loop_exception_handler(loop, context):
        exc = context.get('exception')
        try:
            if isinstance(exc, ConnectionResetError) and getattr(exc, 'winerror', None) == 10054:
                return
        except Exception:
            pass
        loop.default_exception_handler(context)
    try:
        loop = asyncio.get_event_loop()
        loop.set_exception_handler(_loop_exception_handler)
    except Exception:
        pass
    ensure_dirs()
    db = get_application_db()
    db.initialize()
    print(f"[Auto-Annotator] Database initialized at {db.db_path}")
    print(f"[Auto-Annotator] Server running at http://{HOST}:{PORT}")
    yield
    # Shutdown
    if _app_db:
        _app_db.close()
    print("[Auto-Annotator] Shut down")


# ─── Create app ───────────────────────────────────────────────────────────
app = FastAPI(
    title="Auto-Annotator",
    description="YOLO-based image auto-annotation tool",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Register routes ──────────────────────────────────────────────────────
from routes.images import router as images_router
from routes.annotations import router as annotations_router
from routes.classes import router as classes_router
from routes.models_mgmt import router as models_router
from routes.predictions import router as predictions_router
from routes.review import router as review_router
from routes.comparison import router as comparison_router
from routes.export import router as export_router
from routes.settings import router as settings_router

app.include_router(images_router)
app.include_router(annotations_router)
app.include_router(classes_router)
app.include_router(models_router)
app.include_router(predictions_router)
app.include_router(review_router)
app.include_router(comparison_router)
app.include_router(export_router)
app.include_router(settings_router)

# ─── Static files ─────────────────────────────────────────────────────────
static_dir = Path(__file__).parent / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def index():
    """Serve the main SPA page."""
    return FileResponse(str(static_dir / "index.html"))


# ─── Main entry ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=HOST, port=PORT, reload=True)
