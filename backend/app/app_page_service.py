from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.app_pages import APP_PAGES, APP_PAGE_KEYS
from app.org_models import AppPage, Employee, OrgUserPageAccess


def sync_app_pages(db: Session) -> None:
    known_keys = set(APP_PAGE_KEYS)
    for page in APP_PAGES:
        row = db.get(AppPage, page["page_key"])
        if row is None:
            db.add(
                AppPage(
                    page_key=page["page_key"],
                    label=page["label"],
                    sort_order=page["sort_order"],
                    is_active=True,
                )
            )
        else:
            row.label = page["label"]
            row.sort_order = page["sort_order"]
            row.is_active = True

    for row in db.scalars(select(AppPage)).all():
        if row.page_key not in known_keys:
            row.is_active = False
    db.commit()


def list_app_pages(db: Session, *, active_only: bool = True) -> list[AppPage]:
    stmt = select(AppPage).order_by(AppPage.sort_order, AppPage.page_key)
    if active_only:
        stmt = stmt.where(AppPage.is_active.is_(True))
    return list(db.scalars(stmt).all())


def is_other_user_employee(employee: Employee | None) -> bool:
    return bool(employee and employee.hide_from_pyramid)


def get_user_allowed_page_keys(db: Session, org_user_id: int) -> list[str]:
    rows = db.scalars(
        select(OrgUserPageAccess.page_key)
        .join(AppPage, AppPage.page_key == OrgUserPageAccess.page_key)
        .where(
            OrgUserPageAccess.org_user_id == org_user_id,
            AppPage.is_active.is_(True),
        )
        .order_by(AppPage.sort_order, AppPage.page_key)
    ).all()
    return list(rows)


def set_user_page_access(db: Session, org_user_id: int, page_keys: list[str]) -> list[str]:
    unique_keys = list(dict.fromkeys(key.strip() for key in page_keys if key and key.strip()))
    invalid = [key for key in unique_keys if key not in APP_PAGE_KEYS]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Неизвестные страницы: {', '.join(invalid)}",
        )

    active_keys = {
        row.page_key
        for row in db.scalars(select(AppPage).where(AppPage.page_key.in_(unique_keys), AppPage.is_active.is_(True)))
    }
    missing_active = [key for key in unique_keys if key not in active_keys]
    if missing_active:
        raise HTTPException(
            status_code=400,
            detail=f"Страницы недоступны: {', '.join(missing_active)}",
        )

    current = db.scalars(select(OrgUserPageAccess).where(OrgUserPageAccess.org_user_id == org_user_id)).all()
    current_keys = {row.page_key for row in current}
    target_keys = set(unique_keys)

    for row in current:
        if row.page_key not in target_keys:
            db.delete(row)

    for page_key in unique_keys:
        if page_key not in current_keys:
            db.add(OrgUserPageAccess(org_user_id=org_user_id, page_key=page_key))

    db.flush()
    return get_user_allowed_page_keys(db, org_user_id)


def clear_user_page_access(db: Session, org_user_id: int) -> None:
    for row in db.scalars(select(OrgUserPageAccess).where(OrgUserPageAccess.org_user_id == org_user_id)).all():
        db.delete(row)
