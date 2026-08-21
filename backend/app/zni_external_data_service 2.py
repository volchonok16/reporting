from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Task, ZniExternalData

PRIORITY_MAX_LENGTH = 255
COMMERCIAL_EFFECT_MAX_LENGTH = 4000
ACTUAL_PERIOD_MAX_LENGTH = 128
DESIRED_QUARTER_MAX_LENGTH = 64


def _clean_text(value: str | None, *, max_length: int) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[:max_length]


def load_external_data_by_task_ids(db: Session, task_ids: list[int]) -> dict[int, ZniExternalData]:
    if not task_ids:
        return {}
    rows = db.scalars(select(ZniExternalData).where(ZniExternalData.task_id.in_(task_ids)))
    return {row.task_id: row for row in rows}


def update_zni_external_data(
    db: Session,
    *,
    external_id: str,
    priority: str | None | object = ...,
    commercial_effect: str | None | object = ...,
    actual_period: str | None | object = ...,
    desired_date: date | None | object = ...,
    desired_quarter: str | None | object = ...,
) -> Task:
    task = db.scalar(
        select(Task).where(
            Task.task_type == "change_request",
            Task.external_id == external_id,
        )
    )
    if task is None:
        raise ValueError("ЗНИ не найден")

    row = db.get(ZniExternalData, task.id)
    if row is None:
        row = ZniExternalData(task_id=task.id)
        db.add(row)

    if priority is not ...:
        row.priority = _clean_text(priority if isinstance(priority, str) else None, max_length=PRIORITY_MAX_LENGTH)
    if commercial_effect is not ...:
        row.commercial_effect = _clean_text(
            commercial_effect if isinstance(commercial_effect, str) else None,
            max_length=COMMERCIAL_EFFECT_MAX_LENGTH,
        )
    if actual_period is not ...:
        row.actual_period = _clean_text(
            actual_period if isinstance(actual_period, str) else None,
            max_length=ACTUAL_PERIOD_MAX_LENGTH,
        )
    if desired_date is not ...:
        row.desired_date = desired_date if isinstance(desired_date, date) else None
    if desired_quarter is not ...:
        row.desired_quarter = _clean_text(
            desired_quarter if isinstance(desired_quarter, str) else None,
            max_length=DESIRED_QUARTER_MAX_LENGTH,
        )

    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    return task
