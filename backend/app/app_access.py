from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.auth_sessions import get_session_with_meta
from app.db import get_db

FULL_APP_ROLE = "full"
ROADMAP_APP_ROLE = "roadmap"
ROADMAP_DIGITAL_BOARD_CODE = "digital_streams_b2b"


def normalize_app_role(value: str | None) -> str:
    if value == ROADMAP_APP_ROLE:
        return ROADMAP_APP_ROLE
    return FULL_APP_ROLE


def is_roadmap_role(role: str | None) -> bool:
    return normalize_app_role(role) == ROADMAP_APP_ROLE


def is_voice_only(meta: dict | None) -> bool:
    """Пользователь с галочкой Voice сервисы — только вкладка Voice."""
    if not meta:
        return False
    value = meta.get("voice_only")
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return bool(value)


def sync_board_denied_reason(role: str | None, board_code: str | None) -> str | None:
    if not is_roadmap_role(role):
        return None
    if board_code != ROADMAP_DIGITAL_BOARD_CODE:
        return "Доступна только синхронизация доски Digital Streams B2b"
    return None


def can_manage_org(meta: dict) -> bool:
    """PAT, legacy app_user (full) без org_user, org admin."""
    auth_mode = meta.get("auth_mode")
    app_role = meta.get("app_role") or FULL_APP_ROLE
    org_user_role = meta.get("org_user_role")
    return (
        auth_mode == "pat"
        or (auth_mode == "app_user" and app_role == FULL_APP_ROLE and org_user_role is None)
        or org_user_role == "admin"
    )


def is_admin_user(meta: dict) -> bool:
    """Администратор приложения: PAT или org_user.role = admin."""
    return meta.get("auth_mode") == "pat" or meta.get("org_user_role") == "admin"


def ensure_page_access(db: Session, meta: dict, page_key: str) -> None:
    """Для «других пользователей» (employee.hide_from_pyramid) — только разрешённые вкладки."""
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    org_user_id = meta.get("org_user_id")
    if not org_user_id:
        return

    from app.app_page_service import get_user_allowed_page_keys, is_other_user_employee
    from app.org_service import get_employee_for_org_user

    employee = get_employee_for_org_user(db, int(org_user_id))
    if not is_other_user_employee(employee):
        return

    allowed = get_user_allowed_page_keys(db, int(org_user_id))
    if page_key not in allowed:
        raise HTTPException(status_code=403, detail="Нет доступа к этому разделу.")


def require_app_page(page_key: str):
    def _dependency(
        x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
        db: Session = Depends(get_db),
    ) -> dict:
        auth, meta = get_session_with_meta(x_session_id)
        if auth is None:
            raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
        ensure_page_access(db, meta, page_key)
        return meta

    return _dependency
