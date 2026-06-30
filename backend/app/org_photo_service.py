import logging
import mimetypes
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.config import settings
from app.org_s3_storage import (
    delete_object,
    get_object_bytes,
    minio_configured,
    public_url as minio_public_url,
    put_object,
)

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_PHOTO_BYTES = 5 * 1024 * 1024


def uploads_dir() -> Path:
    base = Path(settings.org_uploads_dir)
    base.mkdir(parents=True, exist_ok=True)
    return base


def employee_photos_dir() -> Path:
    path = uploads_dir() / "employees"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _content_type(ext: str) -> str:
    guessed, _ = mimetypes.guess_type(f"file{ext}")
    return guessed or "application/octet-stream"


async def save_employee_photo(employee_id: int, file: UploadFile) -> str:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Файл не выбран.")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Допустимы PNG, JPG, JPEG, WebP.")

    content = await file.read()
    if len(content) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="Файл больше 5 МБ.")

    rel_path = f"employees/{employee_id}_{uuid4().hex}{ext}"

    if minio_configured():
        try:
            put_object(rel_path, content, _content_type(ext))
            return rel_path
        except Exception as exc:
            logger.warning("MinIO недоступен, сохраняем фото локально: %s", exc)

    target = employee_photos_dir() / Path(rel_path).name
    target.write_bytes(content)
    return rel_path


def photo_public_url(photo_path: str | None) -> str | None:
    if not photo_path:
        return None
    if minio_configured():
        return minio_public_url(photo_path)
    return f"/api/org/photos/{photo_path}"


def delete_photo_file(photo_path: str | None) -> None:
    if not photo_path:
        return
    if minio_configured():
        delete_object(photo_path)
    target = uploads_dir() / photo_path
    if target.is_file():
        target.unlink()


def load_photo_content(photo_path: str) -> tuple[bytes, str] | None:
    target = uploads_dir() / photo_path
    if target.is_file():
        content_type = _content_type(target.suffix.lower())
        return target.read_bytes(), content_type
    if minio_configured():
        return get_object_bytes(photo_path)
    return None
