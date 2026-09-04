from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ZniCategory
from app.schemas import ZniCategoryOut


def _category_out(row: ZniCategory) -> ZniCategoryOut:
    return ZniCategoryOut(
        id=row.id,
        name=row.name,
        sortOrder=row.sort_order,
        isActive=row.is_active,
    )


def list_zni_categories(db: Session, *, active_only: bool = False) -> list[ZniCategoryOut]:
    query = select(ZniCategory).order_by(ZniCategory.sort_order, ZniCategory.name, ZniCategory.id)
    if active_only:
        query = query.where(ZniCategory.is_active.is_(True))
    return [_category_out(row) for row in db.scalars(query).all()]


def ensure_zni_category(db: Session, category_id: int | None) -> None:
    if category_id is None:
        return
    row = db.get(ZniCategory, category_id)
    if row is None:
        raise ValueError("Категория не найдена")
    if not row.is_active:
        raise ValueError("Категория неактивна")
