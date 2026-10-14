"""Вложения строк статуса продукта B2B: MinIO (приватный bucket) + локальный fallback."""

from __future__ import annotations

import logging
import mimetypes
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.app_access import is_superadmin_user
from app.config import settings
from app import org_s3_storage

logger = logging.getLogger(__name__)

SUMMARY_GID = "summary"
ATTACHMENTS_COLUMN = "Вложения"
ATTACHMENTS_JSON_KEY = "__attachments"
DOWNLOAD_PATH_TMPL = "/api/product-status/b2b/attachments/{id}/download"


def _resolve_changed_by(meta: dict[str, Any] | None) -> str | None:
    if not meta:
        return None
    login = meta.get("app_login")
    if isinstance(login, str) and login.strip():
        return login.strip()
    return None


def _assert_office_editable(office: dict[str, Any], meta: dict[str, Any] | None = None) -> None:
    if bool(office.get("editing_locked")) and not is_superadmin_user(meta):
        raise HTTPException(
            status_code=403,
            detail=(
                f"«{office['name']}» заблокирован для внесения изменений. "
                "Для разблокировки обратитесь к Склярову Ивану или Тараскину Александру."
            ),
        )

_SAFE_FILENAME_RE = re.compile(r"[^\w.\- ()\[\]]+", re.UNICODE)


def _safe_filename(name: str) -> str:
    cleaned = _SAFE_FILENAME_RE.sub("_", (name or "file").strip()) or "file"
    return cleaned[:512]


def _attachments_bucket() -> str:
    return (settings.minio_attachments_bucket or "product-status").strip()


def _local_root() -> Path:
    path = Path(settings.product_status_uploads_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def serialize_attachment(row: dict[str, Any]) -> dict[str, Any]:
    attachment_id = int(row["id"])
    return {
        "id": attachment_id,
        "filename": str(row["filename"]),
        "contentType": row.get("content_type"),
        "sizeBytes": int(row.get("size_bytes") or 0),
        "uploadedBy": row.get("uploaded_by"),
        "createdAt": row["created_at"].isoformat() if row.get("created_at") else None,
        "downloadUrl": DOWNLOAD_PATH_TMPL.format(id=attachment_id),
    }


def load_attachments_by_row_ids(
    db: Session,
    row_ids: list[int],
) -> dict[int, list[dict[str, Any]]]:
    if not row_ids:
        return {}
    result = db.execute(
        text(
            """
            SELECT id, row_id, filename, storage_key, content_type, size_bytes,
                   uploaded_by, created_at
            FROM b2b_product_status_attachment
            WHERE row_id = ANY(:row_ids)
            ORDER BY row_id, id
            """
        ),
        {"row_ids": row_ids},
    )
    by_row: dict[int, list[dict[str, Any]]] = {}
    for row in result:
        mapping = dict(row._mapping)
        row_id = int(mapping["row_id"])
        by_row.setdefault(row_id, []).append(serialize_attachment(mapping))
    return by_row


def list_storage_keys_for_rows(db: Session, row_ids: list[int]) -> list[str]:
    if not row_ids:
        return []
    result = db.execute(
        text(
            """
            SELECT storage_key
            FROM b2b_product_status_attachment
            WHERE row_id = ANY(:row_ids)
            """
        ),
        {"row_ids": row_ids},
    )
    return [str(row._mapping["storage_key"]) for row in result]


def delete_storage_objects(storage_keys: list[str]) -> None:
    bucket = _attachments_bucket()
    for key in storage_keys:
        normalized = key.lstrip("/")
        if not normalized:
            continue
        if org_s3_storage.minio_configured():
            org_s3_storage.delete_object(normalized, bucket=bucket)
        local_path = _local_root() / normalized
        if local_path.is_file():
            local_path.unlink(missing_ok=True)


def _resolve_row_office(db: Session, *, row_id: int) -> tuple[dict[str, Any], dict[str, Any]]:
    result = db.execute(
        text(
            """
            SELECT r.id AS row_id, o.id AS office_id, o.gid, o.name, o.editing_locked
            FROM b2b_product_status_row r
            JOIN b2b_product_status_office o ON o.id = r.office_id
            WHERE r.id = :row_id AND o.is_active = TRUE
            """
        ),
        {"row_id": row_id},
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Строка не найдена.")
    mapping = dict(row._mapping)
    office = {
        "id": mapping["office_id"],
        "gid": mapping["gid"],
        "name": mapping["name"],
        "editing_locked": mapping["editing_locked"],
    }
    return mapping, office


async def save_product_status_attachment(
    db: Session,
    *,
    row_id: int,
    gid: str,
    file: UploadFile,
    meta: dict[str, Any],
) -> dict[str, Any]:
    if gid == SUMMARY_GID:
        raise HTTPException(status_code=400, detail="Вкладка «Сводка» только для чтения.")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Файл не выбран.")

    row_meta, office = _resolve_row_office(db, row_id=row_id)
    if str(office["gid"]) != gid:
        raise HTTPException(status_code=400, detail="Строка не принадлежит указанному офису.")
    _assert_office_editable(office, meta)

    content = await file.read()
    max_bytes = int(settings.product_status_max_attachment_bytes)
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=400,
            detail=f"Файл слишком большой (макс. {max_bytes // (1024 * 1024)} МБ).",
        )

    original_name = _safe_filename(file.filename)
    ext = Path(original_name).suffix
    storage_key = f"{office['gid']}/{row_id}/{uuid4().hex}{ext}"
    content_type = file.content_type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"

    stored_in_minio = False
    if org_s3_storage.minio_configured():
        try:
            bucket = _attachments_bucket()
            org_s3_storage.ensure_bucket(bucket)
            org_s3_storage.put_object(
                storage_key,
                content,
                content_type,
                bucket=bucket,
            )
            stored_in_minio = True
        except Exception as exc:  # noqa: BLE001 — fallback на диск
            logger.warning("MinIO upload failed, using local fallback: %s", exc)

    if not stored_in_minio:
        local_path = _local_root() / storage_key
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(content)

    uploaded_by = _resolve_changed_by(meta)
    result = db.execute(
        text(
            """
            INSERT INTO b2b_product_status_attachment (
                row_id, filename, storage_key, content_type, size_bytes, uploaded_by
            )
            VALUES (
                :row_id, :filename, :storage_key, :content_type, :size_bytes, :uploaded_by
            )
            RETURNING id, row_id, filename, storage_key, content_type, size_bytes,
                      uploaded_by, created_at
            """
        ),
        {
            "row_id": int(row_meta["row_id"]),
            "filename": original_name,
            "storage_key": storage_key,
            "content_type": content_type,
            "size_bytes": len(content),
            "uploaded_by": uploaded_by,
        },
    )
    inserted = result.first()
    db.commit()
    return serialize_attachment(dict(inserted._mapping))


def load_product_status_attachment_bytes(
    db: Session,
    *,
    attachment_id: int,
    meta: dict[str, Any] | None = None,
) -> tuple[bytes, str, str]:
    del meta  # доступ как у страницы статуса продукта (require_full_app_access на роуте)
    result = db.execute(
        text(
            """
            SELECT a.id, a.filename, a.storage_key, a.content_type
            FROM b2b_product_status_attachment a
            JOIN b2b_product_status_row r ON r.id = a.row_id
            JOIN b2b_product_status_office o ON o.id = r.office_id
            WHERE a.id = :attachment_id AND o.is_active = TRUE
            """
        ),
        {"attachment_id": attachment_id},
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Вложение не найдено.")
    mapping = dict(row._mapping)
    storage_key = str(mapping["storage_key"]).lstrip("/")
    content_type = mapping.get("content_type") or "application/octet-stream"
    filename = str(mapping["filename"])

    local_path = _local_root() / storage_key
    if local_path.is_file():
        return local_path.read_bytes(), filename, content_type

    if org_s3_storage.minio_configured():
        payload = org_s3_storage.get_object_bytes(storage_key, bucket=_attachments_bucket())
        if payload is not None:
            body, ctype = payload
            return body, filename, ctype or content_type

    raise HTTPException(status_code=404, detail="Файл вложения отсутствует.")


def delete_product_status_attachment(
    db: Session,
    *,
    attachment_id: int,
    meta: dict[str, Any],
) -> dict[str, Any]:
    result = db.execute(
        text(
            """
            SELECT a.id, a.row_id, a.filename, a.storage_key,
                   o.id AS office_id, o.gid, o.name, o.editing_locked
            FROM b2b_product_status_attachment a
            JOIN b2b_product_status_row r ON r.id = a.row_id
            JOIN b2b_product_status_office o ON o.id = r.office_id
            WHERE a.id = :attachment_id AND o.is_active = TRUE
            """
        ),
        {"attachment_id": attachment_id},
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Вложение не найдено.")
    mapping = dict(row._mapping)
    office = {
        "id": mapping["office_id"],
        "gid": mapping["gid"],
        "name": mapping["name"],
        "editing_locked": mapping["editing_locked"],
    }
    if not is_superadmin_user(meta):
        _assert_office_editable(office, meta)

    storage_key = str(mapping["storage_key"])
    db.execute(
        text("DELETE FROM b2b_product_status_attachment WHERE id = :id"),
        {"id": attachment_id},
    )
    db.commit()
    delete_storage_objects([storage_key])
    return {"status": "ok", "gid": str(office["gid"]), "rowId": int(mapping["row_id"])}
