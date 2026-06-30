from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile

from app.config import settings

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


async def save_employee_photo(employee_id: int, file: UploadFile) -> str:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Файл не выбран.")
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Допустимы PNG, JPG, JPEG, WebP.")

    content = await file.read()
    if len(content) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="Файл больше 5 МБ.")

    filename = f"{employee_id}_{uuid4().hex}{ext}"
    rel_path = f"employees/{filename}"
    target = employee_photos_dir() / filename
    target.write_bytes(content)
    return rel_path


def photo_public_url(photo_path: str | None) -> str | None:
    if not photo_path:
        return None
    return f"/api/org/photos/{photo_path}"


def delete_photo_file(photo_path: str | None) -> None:
    if not photo_path:
        return
    target = uploads_dir() / photo_path
    if target.is_file():
        target.unlink()
