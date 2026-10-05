"""One-time import from legacy SQLite registry.sqlite3 into PostgreSQL."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

from .pg_db import PgConnection

logger = logging.getLogger(__name__)


def _sqlite_table_exists(connection: sqlite3.Connection, name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def migrate_sqlite_registry_if_needed(
    data_dir: Path,
    pg: PgConnection,
) -> bool:
    sqlite_path = data_dir / "registry.sqlite3"
    if not sqlite_path.is_file():
        return False

    existing = pg.execute("SELECT COUNT(*) AS c FROM voice_uploads").fetchone()
    if existing is not None and int(existing["c"]) > 0:
        return False

    imported = False
    try:
        with sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True) as sqlite:
            sqlite.row_factory = sqlite3.Row
            if _sqlite_table_exists(sqlite, "uploads"):
                for row in sqlite.execute("SELECT * FROM uploads"):
                    pg.execute(
                        """
                        INSERT INTO voice_uploads(
                            id, session_id, name, size, format, path,
                            created_at, expires_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        (
                            row["id"],
                            row["session_id"],
                            row["name"],
                            int(row["size"]),
                            row["format"],
                            row["path"],
                            float(row["created_at"]),
                            float(row["expires_at"]),
                        ),
                    )
                    imported = True
            if _sqlite_table_exists(sqlite, "jobs"):
                for row in sqlite.execute("SELECT * FROM jobs"):
                    pg.execute(
                        """
                        INSERT INTO voice_jobs(
                            id, session_id, kind, upload_id, status, stage, progress,
                            processed_rows, total_rows, error_json, summary_json,
                            workspace, result_path, report_path,
                            created_at, updated_at, expires_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        (
                            row["id"],
                            row["session_id"],
                            row["kind"],
                            row["upload_id"],
                            row["status"],
                            row["stage"],
                            int(row["progress"]),
                            int(row["processed_rows"]),
                            int(row["total_rows"]),
                            row["error_json"],
                            row["summary_json"],
                            row["workspace"],
                            row["result_path"],
                            row["report_path"],
                            float(row["created_at"]),
                            float(row["updated_at"]),
                            float(row["expires_at"]),
                        ),
                    )
    except sqlite3.Error as exc:
        # Bind-mount / virtiofs EIO на Docker Desktop не должен валить старт API.
        logger.warning(
            "Пропуск импорта legacy registry.sqlite3 (%s): %s",
            sqlite_path,
            exc,
        )
        return False

    if imported:
        backup = sqlite_path.with_suffix(".sqlite3.migrated")
        try:
            sqlite_path.rename(backup)
        except OSError as exc:
            logger.warning("Не удалось переименовать %s → %s: %s", sqlite_path, backup, exc)
    return imported
