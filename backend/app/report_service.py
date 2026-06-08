import csv
import io
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.boards import ALL_BOARDS_CODE, BOARDS, BoardConfig, board_by_code, is_all_boards
from app.config import settings
from app.models import Task
from app.pilot_metrics import count_launched
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


def _board_column(task: Task) -> str | None:
    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    value = extra.get("board_column")
    return str(value).strip() if value else None


def _matches_status(task: Task, status: str | None) -> bool:
    if not status:
        return True
    needle = status.strip().lower()
    column = (_board_column(task) or "").lower()
    workflow = (task.source_status or "").lower()
    return needle in {column, workflow}


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


def _board_name_by_code(code: str | None) -> str | None:
    if not code:
        return None
    for board in BOARDS:
        if board.code == code:
            return board.display_name
    return None


def _collect_available_statuses(rows: list[Task]) -> list[str]:
    values: set[str] = set()
    for row in rows:
        column = _board_column(row)
        if column:
            values.add(column)
        if row.source_status:
            values.add(row.source_status)
    return sorted(values, key=str.casefold)


def _compute_metrics(
    rows: list[Task],
    error_rows: list[Task],
    *,
    date_from: date | None,
    date_to: date | None,
) -> DashboardMetricsOut:
    today = date.today()
    horizon = today + timedelta(days=settings.launching_soon_days)
    launching_soon = sum(
        1
        for row in rows
        if row.release_date and today <= row.release_date <= horizon and row.closed_at is None
    )
    return DashboardMetricsOut(
        totalTasks=len(rows),
        launchingSoon=launching_soon,
        launched=count_launched(rows, date_from=date_from, date_to=date_to),
        errorsCount=len(error_rows),
    )


def load_change_requests(
    db: Session,
    *,
    board_code: str | None,
    search: str | None = None,
    sort: str = "id_desc",
    date_from: date | None = None,
    date_to: date | None = None,
    status: str | None = None,
) -> DashboardOut:
    all_boards = is_all_boards(board_code)
    board = board_by_code(board_code)

    if all_boards:
        board_names = [b.name for b in BOARDS]
        zni_query = select(Task).where(
            Task.task_type == "change_request",
            Task.source_team.in_(board_names),
        )
        error_query = select(Task).where(
            Task.task_type == "error",
            Task.source_team.in_(board_names),
        )
    else:
        if board is None:
            board = BOARDS[0]
        zni_query = select(Task).where(
            Task.task_type == "change_request",
            Task.source_team == board.name,
        )
        error_query = select(Task).where(
            Task.task_type == "error",
            Task.source_team == board.name,
        )

    rows = list(db.scalars(zni_query))
    error_rows = list(db.scalars(error_query))

    filtered = [
        row
        for row in rows
        if _matches_search(row, search or "")
        and _in_date_range(row, date_from, date_to)
        and _matches_status(row, status)
    ]

    reverse = sort.endswith("_desc") or sort == "id_desc"
    sort_field = sort.replace("_desc", "").replace("_asc", "")
    filtered.sort(key=lambda t: _sort_key(t, sort_field), reverse=reverse)

    errors_by_parent: dict[int, list[Task]] = {}
    for error in error_rows:
        if error.parent_task_id:
            errors_by_parent.setdefault(error.parent_task_id, []).append(error)

    items: list[ChangeRequestOut] = []
    for row in filtered:
        linked = errors_by_parent.get(row.id, [])
        board_code_value = (row.extra_json or {}).get("board_code")
        items.append(
            ChangeRequestOut(
                id=str(row.id),
                number=row.external_id,
                title=row.title,
                url=row.external_url,
                status=row.source_status,
                boardColumn=_board_column(row),
                startDate=_effective_start(row),
                releaseDate=row.release_date,
                createdAt=row.created_at,
                boardCode=str(board_code_value) if board_code_value else None,
                boardName=row.source_team or _board_name_by_code(str(board_code_value) if board_code_value else None),
                errors=[
                    LinkedErrorOut(
                        id=e.external_id,
                        title=e.title,
                        status=e.source_status,
                        url=e.external_url,
                    )
                    for e in linked
                ],
            )
        )

    return DashboardOut(
        board=_board_out(board) if board and not all_boards else None,
        allBoards=all_boards,
        metrics=_compute_metrics(rows, error_rows, date_from=date_from, date_to=date_to),
        items=items,
        totalShown=len(items),
        availableStatuses=_collect_available_statuses(rows),
    )


def export_csv(db: Session, *, board_code: str | None = None) -> str:
    if is_all_boards(board_code) or not board_code:
        dashboard = load_change_requests(db, board_code=ALL_BOARDS_CODE)
        boards_to_export = [None]
    else:
        boards_to_export = [board_by_code(board_code)]

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(
        [
            "Номер ЗНИ",
            "ЗНИ",
            "Статус workflow",
            "Статус доски",
            "Дата начала",
            "Целевая дата",
            "Доска",
            "Ошибки",
        ]
    )

    if is_all_boards(board_code) or not board_code:
        for item in dashboard.items:
            errors_text = "; ".join(f"{e.id}: {e.title}" for e in item.errors)
            writer.writerow(
                [
                    item.number,
                    item.title,
                    item.status or "",
                    item.boardColumn or "",
                    item.startDate.isoformat() if item.startDate else "",
                    item.releaseDate.isoformat() if item.releaseDate else "",
                    item.boardName or "",
                    errors_text,
                ]
            )
    else:
        for board in boards_to_export:
            if board is None:
                continue
            single = load_change_requests(db, board_code=board.code)
            for item in single.items:
                errors_text = "; ".join(f"{e.id}: {e.title}" for e in item.errors)
                writer.writerow(
                    [
                        item.number,
                        item.title,
                        item.status or "",
                        item.boardColumn or "",
                        item.startDate.isoformat() if item.startDate else "",
                        item.releaseDate.isoformat() if item.releaseDate else "",
                        item.boardName or "",
                        errors_text,
                    ]
                )
    return output.getvalue()
