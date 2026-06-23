"""План digital: теги квартала, UC и приёмка ЕЦТ."""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.boards import board_by_code
from app.models import Task
from app.schemas import ChangeRequestOut, DigitalPlanOut
from app.tag_filters import DIGITAL_BOARD_CODE

PLAN_TAG_QUARTERS_RE = re.compile(r"Q([1-4])(?:-Q([1-4]))?", re.IGNORECASE)


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


def preserve_digital_plan_fields_in_extra(
    new_extra: dict[str, Any],
    existing_extra: dict[str, Any] | None,
) -> None:
    """Локальное поле UC не приходит из TFS — сохраняем при upsert."""
    if not isinstance(existing_extra, dict):
        return
    has_uc = existing_extra.get("has_uc")
    if has_uc is True or has_uc is False:
        new_extra["has_uc"] = has_uc


def ect_acceptance_from_task(task: Task) -> bool:
    return _extra(task).get("ect_acceptance") is True


def has_uc_from_task(task: Task) -> bool | None:
    value = _extra(task).get("has_uc")
    if value is True:
        return True
    if value is False:
        return False
    return None


def plan_period_from_tag(plan_tag: str, year: int) -> tuple[date, date]:
    match = PLAN_TAG_QUARTERS_RE.search(plan_tag.strip())
    if not match:
        raise ValueError(f"Не удалось определить период плана по тегу: {plan_tag}")

    quarter_from = int(match.group(1))
    quarter_to = int(match.group(2)) if match.group(2) else quarter_from
    if quarter_from > quarter_to:
        raise ValueError(f"Некорректный диапазон кварталов в теге: {plan_tag}")

    start_month = (quarter_from - 1) * 3 + 1
    end_month = quarter_to * 3
    period_from = date(year, start_month, 1)
    if end_month == 12:
        period_to = date(year, 12, 31)
    else:
        period_to = date(year, end_month + 1, 1) - timedelta(days=1)
    return period_from, period_to


def _task_tags(task: Task) -> list[str]:
    raw = _extra(task).get("tags")
    if isinstance(raw, list):
        return [str(tag).strip() for tag in raw if str(tag).strip()]
    if isinstance(raw, str) and raw.strip():
        return [part.strip() for part in raw.split(";") if part.strip()]
    return []


def _task_has_plan_tag(task: Task, plan_tag: str) -> bool:
    normalized = plan_tag.strip().casefold()
    if not normalized:
        return False
    return any(tag.casefold() == normalized for tag in _task_tags(task))


def update_digital_plan_has_uc(
    db: Session,
    *,
    external_id: str,
    has_uc: bool | None,
) -> Task:
    task = db.scalar(
        select(Task).where(
            Task.task_type == "change_request",
            Task.external_id == external_id,
        )
    )
    if task is None:
        raise ValueError("ЗНИ не найден")

    extra = dict(_extra(task))
    if has_uc is None:
        extra.pop("has_uc", None)
    else:
        extra["has_uc"] = has_uc
    task.extra_json = extra
    db.commit()
    db.refresh(task)
    return task


def load_digital_plan(
    db: Session,
    *,
    plan_tag: str,
    year: int,
) -> DigitalPlanOut:
    from app.report_service import (
        _build_errors_by_parent,
        _change_request_to_out,
        _effective_start,
        active_errors,
    )

    board = board_by_code(DIGITAL_BOARD_CODE)
    if board is None:
        raise ValueError("Доска Digital Streams B2b не найдена")

    period_from, period_to = plan_period_from_tag(plan_tag, year)

    rows = list(
        db.scalars(
            select(Task).where(
                Task.task_type == "change_request",
                Task.source_team == board.name,
            )
        )
    )
    error_rows = active_errors(
        list(
            db.scalars(
                select(Task).where(
                    Task.task_type == "error",
                    Task.source_team == board.name,
                )
            )
        )
    )
    errors_by_parent = _build_errors_by_parent(rows, error_rows)

    filtered: list[Task] = []
    for row in rows:
        if not _task_has_plan_tag(row, plan_tag):
            continue
        start = _effective_start(row)
        if start is not None and (start < period_from or start > period_to):
            continue
        filtered.append(row)

    filtered.sort(
        key=lambda row: (
            _effective_start(row) or date.max,
            int(row.external_id) if row.external_id.isdigit() else 0,
        )
    )

    items: list[ChangeRequestOut] = [
        _change_request_to_out(row, errors_by_parent.get(row.id, []))
        for row in filtered
    ]

    return DigitalPlanOut(
        planTag=plan_tag,
        periodFrom=period_from,
        periodTo=period_to,
        items=items,
        totalShown=len(items),
    )
