from sqlalchemy import select
from sqlalchemy.orm import Session

from app.boards import board_by_code
from app.models import Task
from app.tfs_client import TfsClient, build_business_value_patch


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


async def update_business_value(
    db: Session,
    *,
    pat: str,
    external_id: str,
    value: int | None,
) -> Task:
    task = db.scalar(
        select(Task).where(
            Task.task_type == "change_request",
            Task.external_id == external_id,
        )
    )
    if task is None:
        raise ValueError("ЗНИ не найден")

    board_code = _extra(task).get("board_code")
    board = board_by_code(str(board_code)) if board_code else None
    if board is None:
        raise ValueError("Доска ЗНИ не определена")

    client = TfsClient(board.to_tfs_auth(pat))
    await client.patch_work_item(int(external_id), build_business_value_patch(value))

    extra = dict(_extra(task))
    if value is None:
        extra.pop("business_value", None)
    else:
        extra["business_value"] = value
    task.extra_json = extra
    db.commit()
    db.refresh(task)
    return task
