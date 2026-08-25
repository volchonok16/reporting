from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.board_metrics import matches_board_states
from app.config import settings
from app.models import Task, ZniExternalData

PRIORITY_MAX_LENGTH = 255
COMMERCIAL_EFFECT_MAX_LENGTH = 4000
COMMENT_MAX_LENGTH = 4000
ACTUAL_PERIOD_MAX_LENGTH = 128
DESIRED_QUARTER_MAX_LENGTH = 64


def _clean_text(value: str | None, *, max_length: int) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[:max_length]


def actual_period_editable_statuses() -> list[str]:
    return list(settings.actual_period_editable_state_list)


def can_edit_actual_period(task: Task) -> bool:
    return matches_board_states(task, tuple(actual_period_editable_statuses()))


def load_external_data_by_task_ids(db: Session, task_ids: list[int]) -> dict[int, ZniExternalData]:
    if not task_ids:
        return {}
    rows = db.scalars(select(ZniExternalData).where(ZniExternalData.task_id.in_(task_ids)))
    return {row.task_id: row for row in rows}


def update_zni_external_data(
    db: Session,
    *,
    external_id: str,
    priority: str | None = None,
    set_priority: bool = False,
    commercial_effect: str | None = None,
    set_commercial_effect: bool = False,
    actual_period: str | None = None,
    set_actual_period: bool = False,
    desired_date: date | None = None,
    set_desired_date: bool = False,
    desired_quarter: str | None = None,
    set_desired_quarter: bool = False,
    comment: str | None = None,
    set_comment: bool = False,
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

    if set_priority:
        row.priority = _clean_text(priority, max_length=PRIORITY_MAX_LENGTH)
    if set_commercial_effect:
        row.commercial_effect = _clean_text(commercial_effect, max_length=COMMERCIAL_EFFECT_MAX_LENGTH)
    if set_actual_period:
        if not can_edit_actual_period(task):
            allowed = ", ".join(actual_period_editable_statuses()) or "—"
            raise ValueError(
                "Поле «Фактическая дата месяц/квартал» можно менять только "
                f"в статусах: {allowed}"
            )
        row.actual_period = _clean_text(actual_period, max_length=ACTUAL_PERIOD_MAX_LENGTH)
    if set_desired_date:
        row.desired_date = desired_date
    if set_desired_quarter:
        row.desired_quarter = _clean_text(desired_quarter, max_length=DESIRED_QUARTER_MAX_LENGTH)
    if set_comment:
        row.comment = _clean_text(comment, max_length=COMMENT_MAX_LENGTH)

    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(task)
    return task
