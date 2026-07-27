from __future__ import annotations
"""SQLite database connection and schema management."""
import sqlite3
import threading
from datetime import datetime
from config import DATABASE_PATH


class Database:
    """Thread-safe SQLite database wrapper."""

    def __init__(self, db_path=None):
        self.db_path = str(db_path or DATABASE_PATH)
        self._local = threading.local()

    @property
    def conn(self):
        if not hasattr(self._local, 'conn') or self._local.conn is None:
            self._local.conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._local.conn.row_factory = sqlite3.Row
            self._local.conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn.execute("PRAGMA foreign_keys=ON")
        return self._local.conn

    def initialize(self):
        """Create all tables if they don't exist."""
        c = self.conn.cursor()

        c.executescript("""
            CREATE TABLE IF NOT EXISTS images (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                filename        TEXT NOT NULL,
                relative_path   TEXT NOT NULL UNIQUE,
                split           TEXT NOT NULL DEFAULT 'train',
                width           INTEGER NOT NULL DEFAULT 0,
                height          INTEGER NOT NULL DEFAULT 0,
                file_size       INTEGER NOT NULL DEFAULT 0,
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_images_split ON images(split);
            CREATE INDEX IF NOT EXISTS idx_images_path ON images(relative_path);

            CREATE TABLE IF NOT EXISTS annotation_files (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id          INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                file_path         TEXT NOT NULL,
                source            TEXT NOT NULL DEFAULT 'human',
                model_name        TEXT,
                annotation_count  INTEGER NOT NULL DEFAULT 0,
                created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(image_id, source, model_name)
            );
            CREATE INDEX IF NOT EXISTS idx_ann_files_image ON annotation_files(image_id);

            CREATE TABLE IF NOT EXISTS review_status (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                image_id                INTEGER NOT NULL UNIQUE REFERENCES images(id) ON DELETE CASCADE,
                status                  TEXT NOT NULL DEFAULT 'pending',
                has_human_annotation    INTEGER NOT NULL DEFAULT 0,
                has_model_prediction    INTEGER NOT NULL DEFAULT 0,
                human_annotation_count  INTEGER NOT NULL DEFAULT 0,
                model_prediction_count  INTEGER NOT NULL DEFAULT 0,
                reviewed_at             TIMESTAMP,
                notes                   TEXT,
                created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_review_status ON review_status(status);
            CREATE INDEX IF NOT EXISTS idx_review_image ON review_status(image_id);

            CREATE TABLE IF NOT EXISTS models (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT NOT NULL UNIQUE,
                file_path     TEXT NOT NULL,
                model_type    TEXT NOT NULL DEFAULT 'YOLO',
                is_loaded     INTEGER NOT NULL DEFAULT 0,
                class_count   INTEGER NOT NULL DEFAULT 80,
                times_used    INTEGER NOT NULL DEFAULT 0,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS prediction_tasks (
                id              TEXT PRIMARY KEY,
                model_name      TEXT NOT NULL,
                total_images    INTEGER NOT NULL DEFAULT 0,
                processed       INTEGER NOT NULL DEFAULT 0,
                status          TEXT NOT NULL DEFAULT 'running',
                error_message   TEXT,
                started_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at    TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS class_definitions (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                idx     INTEGER NOT NULL UNIQUE,
                name    TEXT NOT NULL,
                color   TEXT NOT NULL DEFAULT '#FF0000'
            );
            CREATE INDEX IF NOT EXISTS idx_class_index ON class_definitions(idx);

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)

        self.conn.commit()

    def fetch_one(self, sql, params=()):
        row = self.conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def fetch_all(self, sql, params=()):
        rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def execute(self, sql, params=()):
        cur = self.conn.execute(sql, params)
        self.conn.commit()
        return cur

    def last_insert_rowid(self):
        return self.conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    def close(self):
        if hasattr(self._local, 'conn') and self._local.conn:
            self._local.conn.close()
            self._local.conn = None
