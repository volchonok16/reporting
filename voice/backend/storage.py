from __future__ import annotations

import json
import os
import secrets
import shutil
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import UploadFile

from .config import Settings
from .errors import AppError
from .security import detect_file_format, safe_display_name


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


@dataclass(frozen=True, slots=True)
class UploadRecord:
    id: str
    session_id: str
    name: str
    size: int
    format: str
    path: Path
    created_at: float
    expires_at: float


@dataclass(frozen=True, slots=True)
class JobRecord:
    id: str
    session_id: str
    kind: str
    upload_id: str
    status: str
    stage: str
    progress: int
    processed_rows: int
    total_rows: int
    error: dict[str, Any] | None
    summary: dict[str, Any] | None
    workspace: Path
    result_path: Path
    report_path: Path
    created_at: float
    updated_at: float
    expires_at: float


def opaque_id() -> str:
    return secrets.token_urlsafe(18)


class Registry:
    def __init__(self, config: Settings):
        self.config = config
        self.config.data_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = self.config.data_dir / "registry.sqlite3"
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS uploads (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    format TEXT NOT NULL,
                    path TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS uploads_owner
                    ON uploads(id, session_id);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    upload_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    progress INTEGER NOT NULL,
                    processed_rows INTEGER NOT NULL,
                    total_rows INTEGER NOT NULL,
                    error_json TEXT,
                    summary_json TEXT,
                    workspace TEXT NOT NULL,
                    result_path TEXT NOT NULL,
                    report_path TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    expires_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS jobs_owner
                    ON jobs(id, session_id);
                """
            )
            now = time.time()
            interrupted_error = json.dumps(
                {
                    "code": "SERVER_RESTARTED",
                    "message": "Задание прервано перезапуском сервиса",
                },
                ensure_ascii=False,
            )
            connection.execute(
                """
                UPDATE jobs
                SET status = 'failed',
                    stage = 'Прервано',
                    error_json = ?,
                    updated_at = ?,
                    expires_at = ?
                WHERE status NOT IN ('completed', 'failed', 'cancelled')
                """,
                (
                    interrupted_error,
                    now,
                    now + self.config.object_ttl_seconds,
                ),
            )

    def add_upload(self, record: UploadRecord) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO uploads
                (id, session_id, name, size, format, path, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.session_id,
                    record.name,
                    record.size,
                    record.format,
                    str(record.path),
                    record.created_at,
                    record.expires_at,
                ),
            )

    def get_upload(
        self, upload_id: str, session_id: str, *, touch: bool = True
    ) -> UploadRecord:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM uploads WHERE id = ? AND session_id = ?",
                (upload_id, session_id),
            ).fetchone()
            if row is None:
                raise AppError("UPLOAD_NOT_FOUND", "Загрузка не найдена", status_code=404)
            expires_at = float(row["expires_at"])
            if touch:
                expires_at = time.time() + self.config.object_ttl_seconds
                connection.execute(
                    "UPDATE uploads SET expires_at = ? WHERE id = ?",
                    (expires_at, upload_id),
                )
            return UploadRecord(
                id=row["id"],
                session_id=row["session_id"],
                name=row["name"],
                size=int(row["size"]),
                format=row["format"],
                path=Path(row["path"]),
                created_at=float(row["created_at"]),
                expires_at=expires_at,
            )

    def add_job(self, record: JobRecord) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO jobs (
                    id, session_id, kind, upload_id, status, stage, progress,
                    processed_rows, total_rows, error_json, summary_json,
                    workspace, result_path, report_path, created_at, updated_at,
                    expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.session_id,
                    record.kind,
                    record.upload_id,
                    record.status,
                    record.stage,
                    record.progress,
                    record.processed_rows,
                    record.total_rows,
                    json.dumps(record.error, ensure_ascii=False)
                    if record.error is not None
                    else None,
                    json.dumps(record.summary, ensure_ascii=False)
                    if record.summary is not None
                    else None,
                    str(record.workspace),
                    str(record.result_path),
                    str(record.report_path),
                    record.created_at,
                    record.updated_at,
                    record.expires_at,
                ),
            )

    @staticmethod
    def _job_from_row(row: sqlite3.Row) -> JobRecord:
        return JobRecord(
            id=row["id"],
            session_id=row["session_id"],
            kind=row["kind"],
            upload_id=row["upload_id"],
            status=row["status"],
            stage=row["stage"],
            progress=int(row["progress"]),
            processed_rows=int(row["processed_rows"]),
            total_rows=int(row["total_rows"]),
            error=json.loads(row["error_json"]) if row["error_json"] else None,
            summary=json.loads(row["summary_json"]) if row["summary_json"] else None,
            workspace=Path(row["workspace"]),
            result_path=Path(row["result_path"]),
            report_path=Path(row["report_path"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            expires_at=float(row["expires_at"]),
        )

    def get_job(
        self, job_id: str, session_id: str, *, touch: bool = True
    ) -> JobRecord:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE id = ? AND session_id = ?",
                (job_id, session_id),
            ).fetchone()
            if row is None:
                raise AppError("JOB_NOT_FOUND", "Задание не найдено", status_code=404)
            if touch:
                expires_at = time.time() + self.config.object_ttl_seconds
                connection.execute(
                    "UPDATE jobs SET expires_at = ? WHERE id = ?",
                    (expires_at, job_id),
                )
                mutable = dict(row)
                mutable["expires_at"] = expires_at
                return self._job_from_mapping(mutable)
            return self._job_from_row(row)

    @staticmethod
    def _job_from_mapping(row: dict[str, Any]) -> JobRecord:
        return JobRecord(
            id=row["id"],
            session_id=row["session_id"],
            kind=row["kind"],
            upload_id=row["upload_id"],
            status=row["status"],
            stage=row["stage"],
            progress=int(row["progress"]),
            processed_rows=int(row["processed_rows"]),
            total_rows=int(row["total_rows"]),
            error=json.loads(row["error_json"]) if row["error_json"] else None,
            summary=json.loads(row["summary_json"]) if row["summary_json"] else None,
            workspace=Path(row["workspace"]),
            result_path=Path(row["result_path"]),
            report_path=Path(row["report_path"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            expires_at=float(row["expires_at"]),
        )

    def update_job(self, job_id: str, **updates: Any) -> None:
        allowed = {
            "status",
            "stage",
            "progress",
            "processed_rows",
            "total_rows",
            "error",
            "summary",
        }
        unknown = set(updates) - allowed
        if unknown:
            raise ValueError(f"unknown job fields: {sorted(unknown)}")
        columns: list[str] = []
        values: list[Any] = []
        for key, value in updates.items():
            column = {"error": "error_json", "summary": "summary_json"}.get(key, key)
            columns.append(f"{column} = ?")
            values.append(
                json.dumps(value, ensure_ascii=False)
                if key in {"error", "summary"} and value is not None
                else value
            )
        now = time.time()
        columns.extend(["updated_at = ?", "expires_at = ?"])
        values.extend([now, now + self.config.object_ttl_seconds, job_id])
        with self._lock, self._connect() as connection:
            connection.execute(
                f"UPDATE jobs SET {', '.join(columns)} WHERE id = ?", values
            )

    def cleanup_expired(self) -> tuple[int, int]:
        now = time.time()
        upload_paths: list[Path] = []
        job_paths: list[Path] = []
        with self._lock, self._connect() as connection:
            expired_jobs = connection.execute(
                """
                SELECT id, workspace FROM jobs
                WHERE expires_at < ?
                  AND status IN ('completed', 'failed', 'cancelled')
                """,
                (now,),
            ).fetchall()
            for row in expired_jobs:
                job_paths.append(Path(row["workspace"]))
                connection.execute("DELETE FROM jobs WHERE id = ?", (row["id"],))

            expired_uploads = connection.execute(
                """
                SELECT u.id, u.path
                FROM uploads AS u
                WHERE u.expires_at < ?
                  AND NOT EXISTS (
                    SELECT 1 FROM jobs AS j
                    WHERE j.upload_id = u.id
                      AND j.status NOT IN ('completed', 'failed', 'cancelled')
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM master_imports AS mi
                    WHERE mi.upload_id = u.id
                      AND mi.status IN ('queued', 'analyzing')
                  )
                """,
                (now,),
            ).fetchall()
            for row in expired_uploads:
                upload_paths.append(Path(row["path"]).parent)
                connection.execute("DELETE FROM uploads WHERE id = ?", (row["id"],))
        for path in job_paths + upload_paths:
            self._remove_workspace(path)
        return len(upload_paths), len(job_paths)

    def _remove_workspace(self, path: Path) -> None:
        root = self.config.data_dir.resolve()
        resolved = path.resolve()
        if resolved == root or root not in resolved.parents:
            return
        shutil.rmtree(resolved, ignore_errors=True)


class UploadService:
    def __init__(self, config: Settings, registry: Registry):
        self.config = config
        self.registry = registry
        (self.config.data_dir / "pending").mkdir(parents=True, exist_ok=True)
        (self.config.data_dir / "uploads").mkdir(parents=True, exist_ok=True)

    async def save(self, upload: UploadFile, session_id: str) -> UploadRecord:
        display_name = safe_display_name(upload.filename)
        pending_id = opaque_id()
        pending_dir = self.config.data_dir / "pending" / pending_id
        pending_dir.mkdir(mode=0o700)
        source_path = pending_dir / "source"
        size = 0
        try:
            with source_path.open("xb") as target:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self.config.max_upload_bytes:
                        raise AppError(
                            "FILE_TOO_LARGE",
                            "Размер файла превышает допустимый лимит",
                            status_code=413,
                        )
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if size == 0:
                raise AppError("EMPTY_FILE", "Файл пуст")
            format_name = detect_file_format(
                source_path, display_name, self.config
            )
            # Validate that the workbook metadata can actually be opened before
            # the upload becomes visible in the registry. Import is read-only;
            # formulas/macros are never evaluated or executed.
            if format_name != "csv":
                from .importers import importer_for

                if not importer_for(source_path, format_name).listSheets():
                    raise AppError("EMPTY_FILE", "Книга не содержит листов")
            upload_id = opaque_id()
            final_dir = self.config.data_dir / "uploads" / upload_id
            os.chmod(source_path, 0o400)
            os.replace(pending_dir, final_dir)
            final_path = final_dir / "source"
            now = time.time()
            record = UploadRecord(
                id=upload_id,
                session_id=session_id,
                name=display_name,
                size=size,
                format=format_name,
                path=final_path,
                created_at=now,
                expires_at=now + self.config.object_ttl_seconds,
            )
            try:
                self.registry.add_upload(record)
            except BaseException:
                shutil.rmtree(final_dir, ignore_errors=True)
                raise
            return record
        except BaseException:
            shutil.rmtree(pending_dir, ignore_errors=True)
            raise
        finally:
            await upload.close()
