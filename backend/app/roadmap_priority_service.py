from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Task

RoadmapPriority = Literal["red", "yellow", "green"]
VALID_ROADMAP_PRIORITIES: frozenset[str] = frozenset(
    {"red", "yellow", "green"}
)
ROADMAP_COMMENT_MAX_LENGTH = 500


def preserve_roadmap_priority_in_extra(
    new_extra: dict[str, Any],
    existing_extra: dict[str, Any] | None,
) -> None:
    """Локальные поля Roadmap не приходят из TFS — сохраняем при upsert."""
    if not isinstance(existing_extra, dict):
        return
    value = existing_extra.get("roadmap_priority")
    if isinstance(value, str) and value in VALID_ROADMAP_PRIORITIES:
        new_extra["roadmap_priority"] = value
    comment = existing_extra.get("roadmap_comment")
    if isinstance(comment, str):
        trimmed = comment.strip()
        if trimmed:
            new_extra["roadmap_comment"] = trimmed[:ROADMAP_COMMENT_MAX_LENGTH]


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


def roadmap_priority_from_task(task: Task) -> str | None:
    value = _extra(task).get("roadmap_priority")
    if isinstance(value, str) and value in VALID_ROADMAP_PRIORITIES:
        return value
    return None


def roadmap_comment_from_task(task: Task) -> str | None:
    value = _extra(task).get("roadmap_comment")
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def update_roadmap_priority(
    db: Session,
    *,
    external_id: str,
    priority: RoadmapPriority | None,
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
    if priority is None:
        extra.pop("roadmap_priority", None)
    else:
        extra["roadmap_priority"] = priority
    task.extra_json = extra
    db.commit()
    db.refresh(task)
    return task


def update_roadmap_comment(
    db: Session,
    *,
    external_id: str,
    comment: str | None,
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
    if comment is None or not comment.strip():
        extra.pop("roadmap_comment", None)
    else:
        extra["roadmap_comment"] = comment.strip()[:ROADMAP_COMMENT_MAX_LENGTH]
    task.extra_json = extra
    db.commit()
    db.refresh(task)
    return task
