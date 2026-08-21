from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.notification_models import AppNotification, AppNotificationRecipient
from app.notification_schemas import (
    AppNotificationCreateIn,
    AppNotificationCreateOut,
    AppNotificationOut,
)
from app.org_models import (
    ORG_USER_STATUS_ACTIVE,
    DepartmentMember,
    Employee,
    OrgUser,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _recipient_org_user_ids(
    db: Session,
    *,
    audience: str,
    org_user_ids: list[int],
    department_ids: list[int],
) -> list[int]:
    if audience == "all":
        rows = db.scalars(
            select(OrgUser.id).where(OrgUser.status == ORG_USER_STATUS_ACTIVE).order_by(OrgUser.id)
        ).all()
        return list(rows)

    if audience == "users":
        ids = sorted({int(value) for value in org_user_ids if int(value) > 0})
        if not ids:
            raise HTTPException(status_code=400, detail="Укажите хотя бы одного пользователя.")
        found = set(
            db.scalars(
                select(OrgUser.id).where(
                    OrgUser.id.in_(ids),
                    OrgUser.status == ORG_USER_STATUS_ACTIVE,
                )
            ).all()
        )
        missing = [user_id for user_id in ids if user_id not in found]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Пользователи не найдены или неактивны: {', '.join(map(str, missing))}",
            )
        return ids

    if audience == "departments":
        ids = sorted({int(value) for value in department_ids if int(value) > 0})
        if not ids:
            raise HTTPException(status_code=400, detail="Укажите хотя бы один отдел.")
        rows = db.scalars(
            select(Employee.user_id)
            .join(DepartmentMember, DepartmentMember.employee_id == Employee.id)
            .join(OrgUser, OrgUser.id == Employee.user_id)
            .where(
                DepartmentMember.department_id.in_(ids),
                Employee.user_id.is_not(None),
                Employee.is_active.is_(True),
                OrgUser.status == ORG_USER_STATUS_ACTIVE,
            )
            .distinct()
            .order_by(Employee.user_id)
        ).all()
        resolved = [int(user_id) for user_id in rows if user_id is not None]
        if not resolved:
            raise HTTPException(
                status_code=400,
                detail="В выбранных отделах нет пользователей с учётной записью.",
            )
        return resolved

    raise HTTPException(status_code=400, detail="Неизвестный тип аудитории.")


def create_notification(
    db: Session,
    data: AppNotificationCreateIn,
    *,
    created_by_org_user_id: int | None,
) -> AppNotificationCreateOut:
    title = data.title.strip()
    body = data.body.strip()
    if not title or not body:
        raise HTTPException(status_code=400, detail="Заполните заголовок и текст уведомления.")

    recipient_ids = _recipient_org_user_ids(
        db,
        audience=data.audience,
        org_user_ids=data.orgUserIds,
        department_ids=data.departmentIds,
    )

    notification = AppNotification(
        title=title[:255],
        body=body[:4000],
        audience=data.audience,
        created_by_org_user_id=created_by_org_user_id,
    )
    db.add(notification)
    db.flush()

    for org_user_id in recipient_ids:
        db.add(
            AppNotificationRecipient(
                notification_id=notification.id,
                org_user_id=org_user_id,
            )
        )
    db.commit()
    return AppNotificationCreateOut(id=notification.id, recipientCount=len(recipient_ids))


def list_inbox(
    db: Session,
    *,
    org_user_id: int,
    unread_only: bool = False,
    limit: int = 50,
) -> list[AppNotificationOut]:
    limit = max(1, min(limit, 100))
    query = (
        select(AppNotification, AppNotificationRecipient)
        .join(
            AppNotificationRecipient,
            AppNotificationRecipient.notification_id == AppNotification.id,
        )
        .where(AppNotificationRecipient.org_user_id == org_user_id)
        .order_by(AppNotification.created_at.desc(), AppNotification.id.desc())
        .limit(limit)
    )
    if unread_only:
        query = query.where(AppNotificationRecipient.read_at.is_(None))

    rows = db.execute(query).all()
    items: list[AppNotificationOut] = []
    for notification, recipient in rows:
        items.append(
            AppNotificationOut(
                id=notification.id,
                title=notification.title,
                body=notification.body,
                audience=notification.audience,  # type: ignore[arg-type]
                createdAt=notification.created_at,
                readAt=recipient.read_at,
                isRead=recipient.read_at is not None,
            )
        )
    return items


def unread_count(db: Session, *, org_user_id: int) -> int:
    value = db.scalar(
        select(func.count())
        .select_from(AppNotificationRecipient)
        .where(
            AppNotificationRecipient.org_user_id == org_user_id,
            AppNotificationRecipient.read_at.is_(None),
        )
    )
    return int(value or 0)


def claim_popup_notifications(db: Session, *, org_user_id: int, limit: int = 5) -> list[AppNotificationOut]:
    limit = max(1, min(limit, 10))
    rows = db.execute(
        select(AppNotification, AppNotificationRecipient)
        .join(
            AppNotificationRecipient,
            AppNotificationRecipient.notification_id == AppNotification.id,
        )
        .where(
            AppNotificationRecipient.org_user_id == org_user_id,
            AppNotificationRecipient.read_at.is_(None),
            AppNotificationRecipient.popup_shown_at.is_(None),
        )
        .order_by(AppNotification.created_at.asc(), AppNotification.id.asc())
        .limit(limit)
    ).all()
    if not rows:
        return []

    now = _now()
    items: list[AppNotificationOut] = []
    for notification, recipient in rows:
        recipient.popup_shown_at = now
        items.append(
            AppNotificationOut(
                id=notification.id,
                title=notification.title,
                body=notification.body,
                audience=notification.audience,  # type: ignore[arg-type]
                createdAt=notification.created_at,
                readAt=recipient.read_at,
                isRead=False,
            )
        )
    db.commit()
    return items


def mark_read(db: Session, *, org_user_id: int, notification_id: int) -> AppNotificationOut:
    row = db.execute(
        select(AppNotification, AppNotificationRecipient)
        .join(
            AppNotificationRecipient,
            AppNotificationRecipient.notification_id == AppNotification.id,
        )
        .where(
            AppNotification.id == notification_id,
            AppNotificationRecipient.org_user_id == org_user_id,
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Уведомление не найдено.")

    notification, recipient = row
    if recipient.read_at is None:
        recipient.read_at = _now()
        if recipient.popup_shown_at is None:
            recipient.popup_shown_at = recipient.read_at
        db.commit()

    return AppNotificationOut(
        id=notification.id,
        title=notification.title,
        body=notification.body,
        audience=notification.audience,  # type: ignore[arg-type]
        createdAt=notification.created_at,
        readAt=recipient.read_at,
        isRead=True,
    )


def mark_all_read(db: Session, *, org_user_id: int) -> int:
    now = _now()
    rows = list(
        db.scalars(
            select(AppNotificationRecipient).where(
                AppNotificationRecipient.org_user_id == org_user_id,
                AppNotificationRecipient.read_at.is_(None),
            )
        )
    )
    for recipient in rows:
        recipient.read_at = now
        if recipient.popup_shown_at is None:
            recipient.popup_shown_at = now
    db.commit()
    return len(rows)
