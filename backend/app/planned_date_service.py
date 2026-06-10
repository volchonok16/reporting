from datetime import date

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.boards import BOARDS, board_by_code
from app.iteration_plan import quarter_key_from_date
from app.models import Task
from app.report_service import _task_plan_meta
from app.schemas import PlannedDateUpdateOut
from app.tfs_client import TfsClient


def _board_for_task(task: Task):
    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    board_code = extra.get("board_code")
    if board_code:
        board = board_by_code(str(board_code))
        if board is not None:
            return board

    for board in BOARDS:
        if task.source_team in {board.name, board.display_name}:
            return board
    return None


def _planned_date_out(task: Task) -> PlannedDateUpdateOut:
    planned_date, _, quarter_label, planned_label = _task_plan_meta(task)
    return PlannedDateUpdateOut(
        id=str(task.id),
        number=task.external_id,
        plannedDate=planned_date,
        plannedLabel=planned_label,
        planQuarter=quarter_label,
        releaseDate=task.release_date,
    )


async def update_task_planned_date(
    db: Session,
    *,
    task_id: int,
    planned_date: date | None,
    pat: str,
) -> PlannedDateUpdateOut:
    task = db.get(Task, task_id)
    if task is None or task.task_type != "change_request":
        raise HTTPException(status_code=404, detail="ЗНИ не найдена")

    board = _board_for_task(task)
    if board is None:
        raise HTTPException(status_code=400, detail="Не удалось определить доску для ЗНИ")

    try:
        work_item_id = int(task.external_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный номер ЗНИ") from exc

    client = TfsClient(board.to_tfs_auth(pat))
    try:
        await client.update_target_date(work_item_id, planned_date)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"TFS: не удалось обновить целевую дату ({exc})") from exc
    finally:
        await client.close()

    extra = dict(task.extra_json) if isinstance(task.extra_json, dict) else {}
    task.release_date = planned_date
    if planned_date is None:
        extra.pop("planned_date", None)
        extra.pop("planned_status", None)
        extra.pop("plan_quarter", None)
    else:
        extra["planned_status"] = "date"
        extra["planned_date"] = planned_date.isoformat()
        extra["plan_quarter"] = quarter_key_from_date(planned_date)

    task.extra_json = extra
    db.add(task)
    db.commit()
    db.refresh(task)
    return _planned_date_out(task)
