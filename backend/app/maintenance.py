"""Режим обслуживания: запрет входа не-админам, сообщение о работах, массовый logout."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.app_access import is_admin_user
from app.models import AppMaintenance

DEFAULT_MAINTENANCE_MESSAGE = (
    "Проводятся технические работы. Вход временно недоступен. Попробуйте позже."
)


@dataclass(frozen=True)
class MaintenanceState:
    enabled: bool
    message: str
    allow_admin: bool
    updated_at: datetime | None = None
    updated_by_org_user_id: int | None = None

    @property
    def public_message(self) -> str:
        text = (self.message or "").strip()
        if text:
            return text
        return DEFAULT_MAINTENANCE_MESSAGE if self.enabled else ""


def _ensure_row(db: Session) -> AppMaintenance:
    row = db.get(AppMaintenance, 1)
    if row is None:
        row = AppMaintenance(id=1, enabled=False, message="", allow_admin=True)
        db.add(row)
        db.flush()
    return row


def get_maintenance_state(db: Session) -> MaintenanceState:
    row = _ensure_row(db)
    return MaintenanceState(
        enabled=bool(row.enabled),
        message=row.message or "",
        allow_admin=bool(row.allow_admin),
        updated_at=row.updated_at,
        updated_by_org_user_id=row.updated_by_org_user_id,
    )


def meta_allowed_during_maintenance(meta: dict | None, state: MaintenanceState) -> bool:
    if not state.enabled:
        return True
    if not state.allow_admin:
        return False
    return is_admin_user(meta or {})


def raise_if_login_blocked(db: Session, *, meta_for_user: dict) -> None:
    state = get_maintenance_state(db)
    if meta_allowed_during_maintenance(meta_for_user, state):
        return
    raise HTTPException(status_code=503, detail=state.public_message)


def set_maintenance_state(
    db: Session,
    *,
    enabled: bool | None = None,
    message: str | None = None,
    allow_admin: bool | None = None,
    updated_by_org_user_id: int | None = None,
) -> MaintenanceState:
    row = _ensure_row(db)
    if enabled is not None:
        row.enabled = bool(enabled)
    if message is not None:
        row.message = message.strip()
    if allow_admin is not None:
        row.allow_admin = bool(allow_admin)
    if updated_by_org_user_id is not None:
        row.updated_by_org_user_id = updated_by_org_user_id
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return MaintenanceState(
        enabled=bool(row.enabled),
        message=row.message or "",
        allow_admin=bool(row.allow_admin),
        updated_at=row.updated_at,
        updated_by_org_user_id=row.updated_by_org_user_id,
    )
