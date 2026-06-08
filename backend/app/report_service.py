import csv
import io
from datetime import date, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.boards import BOARDS, BoardConfig, board_by_code, default_board
from app.config import settings
from app.models import Task
from app.schemas import (
    BoardOut,
    ChangeRequestOut,
    DashboardMetricsOut,
    DashboardOut,
    LinkedErrorOut,
)


def _board_out(board: BoardConfig) -> BoardOut:
    return BoardOut(code=board.code, name=board.name, displayName=board.display_name, project=board.project)


def _matches_search(task: Task, search: str) -> bool:
    if not search:
        return True
    needle = search.strip().lower()
    return needle in task.external_id.lower() or needle in task.title.lower()


def _effective_start(task: Task) -> date | None:
    return task.start_date or (task.created_at.date() if task.created_at else None)


def _in_date_range(task: Task, date_from: date | None, date_to: date | None) -> bool:
    if not date_from and not date_to:
        return True
    start = _effective_start(task)
    if start is None:
        return False
    if date_from and start < date_from:
        return False
    if date_to and start > date_to:
        return False
    return True


def _sort_key(task: Task, sort: str):
    if sort == "release_date":
        return task.release_date or date.min
    if sort == "start_date":
        return _effective_start(task) or date.min
    if sort == "created_at":
        return task.created_at or date.min
    try:
        return int(task.external_id)
    except ValueError:
        return 0


def load_change_requests(
    db: Session,
    *,
    board_code: str | None,
    search: str | None = None,
    sort: str = "id_desc",
    date_from: date | None = None,
    date_to: date | None = None,
) -> DashboardOut:
    board = board_by_code(board_code) or default_board()

    query = select(Task).where(
        Task.task_type == "change_request",
        Task.source_team == board.name,
    )
    rows = list(db.scalars(query))

    filtered = [row for row in rows if _matches_search(row, search or "") and _in_date_range(row, date_from, date_to)]

    reverse = sort.endswith("_desc") or sort == "id_desc"
    sort_field = sort.replace("_desc", "").replace("_asc", "")
    filtered.sort(key=lambda t: _sort_key(t, sort_field), reverse=reverse)

    today = date.today()
    horizon = today + timedelta(days=settings.launching_soon_days)
    launching_soon = sum(
        1
        for row in rows
        if row.release_date and today <= row.release_date <= horizon and row.closed_at is None
    )

    error_rows = db.scalars(
        select(Task).where(
            Task.task_type == "error",
            Task.source_team == board.name,
        )
    ).all()
    errors_by_parent: dict[int, list[Task]] = {}
    for error in error_rows:
        if error.parent_task_id:
            errors_by_parent.setdefault(error.parent_task_id, []).append(error)

    items: list[ChangeRequestOut] = []
    for row in filtered:
        linked = errors_by_parent.get(row.id, [])
        items.append(
            ChangeRequestOut(
                id=str(row.id),
                number=row.external_id,
                title=row.title,
                status=row.source_status,
                startDate=_effective_start(row),
                releaseDate=row.release_date,
                createdAt=row.created_at,
                boardCode=board.code,
                boardName=board.display_name,
                errors=[
                    LinkedErrorOut(id=e.external_id, title=e.title, status=e.source_status) for e in linked
                ],
            )
        )

    return DashboardOut(
        board=_board_out(board),
        metrics=DashboardMetricsOut(
            totalTasks=len(rows),
            launchingSoon=launching_soon,
            errorsCount=len(error_rows),
        ),
        items=items,
        totalShown=len(items),
    )


def export_csv(db: Session, *, board_code: str | None = None) -> str:
    boards = [board_by_code(board_code)] if board_code else list(BOARDS)
    boards = [b for b in boards if b is not None]

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(
        [
            "Номер ЗНИ",
            "ЗНИ",
            "Статус",
            "Дата начала",
            "Целевая дата",
            "Доска",
            "Ошибки",
        ]
    )
    for board in boards:
        dashboard = load_change_requests(db, board_code=board.code)
        for item in dashboard.items:
            errors_text = "; ".join(f"{e.id}: {e.title}" for e in item.errors)
            writer.writerow(
                [
                    item.number,
                    item.title,
                    item.status or "",
                    item.startDate.isoformat() if item.startDate else "",
                    item.releaseDate.isoformat() if item.releaseDate else "",
                    item.boardName or "",
                    errors_text,
                ]
            )
    return output.getvalue()
