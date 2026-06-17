from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Task

RoadmapPriority = Literal["red", "yellow", "green"]
VALID_ROADMAP_PRIORITIES: frozenset[str] = frozenset(
    {"red", "yellow", "green"}
)


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


def roadmap_priority_from_task(task: Task) -> str | None:
    value = _extra(task).get("roadmap_priority")
    if isinstance(value, str) and value in VALID_ROADMAP_PRIORITIES:
        return value
    return None


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
