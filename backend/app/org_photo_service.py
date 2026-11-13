import hashlib
import hmac
import logging
import mimetypes
import time
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.config import settings
from app.org_s3_storage import (
    delete_object,
    get_object_bytes,
    minio_configured,
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


def _safe_photo_rel(photo_path: str) -> str | None:
    """Только employees/<id>_<hex>.ext — без path traversal."""
    normalized = photo_path.lstrip("/").replace("\\", "/")
    if not normalized or ".." in normalized.split("/"):
        return None
    parts = normalized.split("/")
    if len(parts) != 2 or parts[0] != "employees":
        return None
    name = parts[1]
    if not name or "/" in name or name.startswith("."):
        return None
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return None
    return f"employees/{name}"


def photo_public_url(photo_path: str | None) -> str | None:
    """Всегда через авторизованный API (не публичный MinIO)."""
    if not photo_path:
        return None
    safe = _safe_photo_rel(photo_path)
    if not safe:
        return None
    return f"/api/org/photos/{safe}"


def _photo_sig(safe: str, exp: int) -> str:
    message = f"{safe}|{exp}".encode()
    secret = settings.canvas_studio_sso_secret.encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def photo_signed_url(photo_path: str | None, ttl_seconds: int = 30 * 24 * 3600) -> str | None:
    """Ссылка для <img> без заголовка сессии. Подпись живёт ttl_seconds."""
    if not photo_path:
        return None
    safe = _safe_photo_rel(photo_path)
    if not safe:
        return None
    exp = int(time.time()) + max(60, ttl_seconds)
    sig = _photo_sig(safe, exp)
    base = settings.app_public_url.rstrip("/")
    return f"{base}/api/org/photos/{safe}?exp={exp}&sig={sig}"


def photo_signature_ok(photo_path: str, exp: int, sig: str) -> bool:
    safe = _safe_photo_rel(photo_path)
    if not safe or not sig or exp < int(time.time()):
        return False
    expected = _photo_sig(safe, exp)
    return hmac.compare_digest(expected, sig.strip())


def delete_photo_file(photo_path: str | None) -> None:
    if not photo_path:
        return
    safe = _safe_photo_rel(photo_path)
    if not safe:
        return
    if minio_configured():
        delete_object(safe)
    target = uploads_dir() / safe
    try:
        target = target.resolve()
        root = uploads_dir().resolve()
        if root not in target.parents and target != root:
            return
    except OSError:
        return
    if target.is_file():
        target.unlink()


def load_photo_content(photo_path: str) -> tuple[bytes, str] | None:
    safe = _safe_photo_rel(photo_path)
    if not safe:
        return None
    root = uploads_dir().resolve()
    target = (root / safe).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None
    if target.is_file():
        content_type = _content_type(target.suffix.lower())
        return target.read_bytes(), content_type
    if minio_configured():
        return get_object_bytes(safe)
    return None
