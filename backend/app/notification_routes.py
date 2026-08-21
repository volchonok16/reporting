from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.app_access import is_admin_user, is_roadmap_role, is_voice_only
from app.auth_sessions import get_session_with_meta
from app.db import get_db
from app.notification_schemas import (
    AppNotificationCreateIn,
    AppNotificationCreateOut,
    AppNotificationOut,
    AppNotificationUnreadCountOut,
)
from app.notification_service import (
    claim_popup_notifications,
    create_notification,
    list_inbox,
    mark_all_read,
    mark_read,
    unread_count,
)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _load_session_meta(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict:
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    return meta


def _require_org_user(meta: dict = Depends(_load_session_meta)) -> tuple[dict, int]:
    org_user_id = meta.get("org_user_id")
    if not org_user_id:
        raise HTTPException(
            status_code=400,
            detail="Уведомления доступны только пользователям с учётной записью.",
        )
    return meta, int(org_user_id)


def _require_sender(meta: dict = Depends(_load_session_meta)) -> dict:
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    if not is_admin_user(meta):
        raise HTTPException(status_code=403, detail="Отправлять уведомления может только администратор.")
    return meta


@router.get("", response_model=list[AppNotificationOut])
def api_list_notifications(
    unreadOnly: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
    ctx: tuple[dict, int] = Depends(_require_org_user),
) -> list[AppNotificationOut]:
    _, org_user_id = ctx
    return list_inbox(db, org_user_id=org_user_id, unread_only=unreadOnly, limit=limit)


@router.get("/unread-count", response_model=AppNotificationUnreadCountOut)
def api_unread_count(
    db: Session = Depends(get_db),
    ctx: tuple[dict, int] = Depends(_require_org_user),
) -> AppNotificationUnreadCountOut:
    _, org_user_id = ctx
    return AppNotificationUnreadCountOut(count=unread_count(db, org_user_id=org_user_id))


@router.get("/popup", response_model=list[AppNotificationOut])
def api_claim_popup(
    db: Session = Depends(get_db),
    ctx: tuple[dict, int] = Depends(_require_org_user),
) -> list[AppNotificationOut]:
    _, org_user_id = ctx
    return claim_popup_notifications(db, org_user_id=org_user_id)


@router.post("/read-all")
def api_mark_all_read(
    db: Session = Depends(get_db),
    ctx: tuple[dict, int] = Depends(_require_org_user),
) -> dict[str, int]:
    _, org_user_id = ctx
    return {"updated": mark_all_read(db, org_user_id=org_user_id)}


@router.post("/{notification_id}/read", response_model=AppNotificationOut)
def api_mark_read(
    notification_id: int,
    db: Session = Depends(get_db),
    ctx: tuple[dict, int] = Depends(_require_org_user),
) -> AppNotificationOut:
    _, org_user_id = ctx
    return mark_read(db, org_user_id=org_user_id, notification_id=notification_id)


@router.post("", response_model=AppNotificationCreateOut)
def api_create_notification(
    payload: AppNotificationCreateIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_require_sender),
) -> AppNotificationCreateOut:
    created_by = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    return create_notification(db, payload, created_by_org_user_id=created_by)
