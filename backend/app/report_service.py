import csv
import io
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.boards import ALL_BOARDS_CODE, BOARDS, BoardConfig, board_by_code, is_all_boards
from app.board_metrics import has_linked_errors, is_completed, is_launched, is_launching_soon
from app.config import settings
from app.iteration_plan import (
    PLAN_QUARTER_TBD,
    parse_iteration_plan,
    quarter_key_from_date,
    quarter_label_from_key,
)
from app.models import Task
from app.completed_metrics import has_customer_name
from app.resource_reservation import ect_resource_reservation_label
from app.zni_description import tfs_identity_display_name
from app.schemas import (
    BoardOut,
    ChangeRequestOut,
    DashboardMetricsOut,
    DashboardOut,
    LinkedErrorOut,
    QuarterOptionOut,
)


def _board_out(board: BoardConfig) -> BoardOut:
    return BoardOut(code=board.code, name=board.name, displayName=board.display_name, project=board.project)


def _matches_search(task: Task, search: str) -> bool:
    if not search:
        return True
    needle = search.strip().lower()
    return needle in task.external_id.lower() or needle in task.title.lower()


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


def _planned_release(task: Task) -> str | None:
    value = _extra(task).get("planned_release")
    return str(value).strip() if value else None


def _ect_resource_reservation(task: Task) -> bool:
    value = _extra(task).get("ect_resource_reservation")
    return value is True


def _customer_name(task: Task) -> str | None:
    value = _extra(task).get("customer_name")
    if not value:
        return None
    return tfs_identity_display_name(value)


def _business_goal(task: Task) -> str | None:
    value = _extra(task).get("business_goal")
    return str(value).strip() if value else None


def _board_column(task: Task) -> str | None:
    value = _extra(task).get("board_column")
    return str(value).strip() if value else None


def _task_plan_meta(task: Task) -> tuple[date | None, str | None, str | None, str | None]:
    extra = _extra(task)
    planned_raw = extra.get("planned_date")
    quarter_key = extra.get("plan_quarter")
    planned_status = extra.get("planned_status")
    planned: date | None = None
    if isinstance(planned_raw, str) and planned_raw:
        try:
            planned = date.fromisoformat(planned_raw)
        except ValueError:
            planned = None

    is_tbd = planned_status == "tbd" or quarter_key == PLAN_QUARTER_TBD
    if not is_tbd and planned is None:
        iteration_path = extra.get("iteration_path")
        if isinstance(iteration_path, str):
            plan = parse_iteration_plan(iteration_path)
            is_tbd = plan.is_tbd
            planned = plan.planned_date
            if not quarter_key:
                quarter_key = plan.quarter_key

    if is_tbd:
        return None, PLAN_QUARTER_TBD, "TBD", "TBD"

    if planned and not quarter_key:
        quarter_key = quarter_key_from_date(planned)
    quarter_key_str = str(quarter_key).strip() if quarter_key else None
    quarter_label = quarter_label_from_key(quarter_key_str) if quarter_key_str else None
    return planned, quarter_key_str, quarter_label, None


def _matches_quarter(task: Task, quarter: str | None) -> bool:
    if not quarter:
        return True
    _, quarter_key, _, _ = _task_plan_meta(task)
    if quarter == "__none__":
        return quarter_key is None
    if quarter == PLAN_QUARTER_TBD:
        return quarter_key == PLAN_QUARTER_TBD
    return quarter_key == quarter


def _matches_status(task: Task, status: str | None) -> bool:
    if not status:
        return True
    needle = status.strip().lower()
    column = (_board_column(task) or "").lower()
    workflow = (task.source_status or "").lower()
    return needle in {column, workflow}


def _effective_start(task: Task) -> date | None:
    return task.start_date or (task.created_at.date() if task.created_at else None)


def _sort_key(task: Task, sort: str):
    if sort == "release_date":
        return task.release_date or date.min
    if sort == "planned_date":
        planned, quarter_key, _, _ = _task_plan_meta(task)
        if quarter_key == PLAN_QUARTER_TBD:
            return date(1900, 1, 1)
        return planned or date.min
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


def _collect_available_quarters(rows: list[Task]) -> list[QuarterOptionOut]:
    keys: set[str] = set()
    for row in rows:
        _, quarter_key, _, _ = _task_plan_meta(row)
        if quarter_key:
            keys.add(quarter_key)
    return [
        QuarterOptionOut(key=key, label=quarter_label_from_key(key))
        for key in sorted(keys, reverse=True)
    ]


def _collect_available_statuses(rows: list[Task]) -> list[str]:
    values: set[str] = set()
    for row in rows:
        column = _board_column(row)
        if column:
            values.add(column)
        if row.source_status:
            values.add(row.source_status)
    return sorted(values, key=str.casefold)


def _matches_metric_filter(
    row: Task,
    metric: str | None,
    *,
    errors_by_parent: dict[int, list[Task]],
    date_from: date | None,
    date_to: date | None,
) -> bool:
    if not metric or metric == "all":
        return True
    today = date.today()
    horizon = today + timedelta(days=settings.launching_soon_days)
    if metric == "launching_soon":
        return is_launching_soon(row, today=today, horizon=horizon)
    if metric == "launched":
        return is_launched(row, date_from=date_from, date_to=date_to)
    if metric == "completed":
        return is_completed(row, date_from=date_from, date_to=date_to)
    if metric == "errors":
        return has_linked_errors(row, errors_by_parent)
    return True


def _compute_metrics(
    rows: list[Task],
    *,
    errors_by_parent: dict[int, list[Task]],
    date_from: date | None,
    date_to: date | None,
) -> DashboardMetricsOut:
    return DashboardMetricsOut(
        totalTasks=len(rows),
        launchingSoon=sum(
            1
            for row in rows
            if _matches_metric_filter(
                row,
                "launching_soon",
                errors_by_parent=errors_by_parent,
                date_from=date_from,
                date_to=date_to,
            )
        ),
        launched=sum(
            1
            for row in rows
            if _matches_metric_filter(
                row,
                "launched",
                errors_by_parent=errors_by_parent,
                date_from=date_from,
                date_to=date_to,
            )
        ),
        completed=sum(
            1
            for row in rows
            if _matches_metric_filter(
                row,
                "completed",
                errors_by_parent=errors_by_parent,
                date_from=date_from,
                date_to=date_to,
            )
        ),
        errorsCount=sum(
            1
            for row in rows
            if _matches_metric_filter(
                row,
                "errors",
                errors_by_parent=errors_by_parent,
                date_from=date_from,
                date_to=date_to,
            )
        ),
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
    quarter: str | None = None,
    metric: str | None = None,
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

    rows_with_customer = [row for row in rows if has_customer_name(row)]

    errors_by_parent: dict[int, list[Task]] = {}
    for error in error_rows:
        if error.parent_task_id:
            errors_by_parent.setdefault(error.parent_task_id, []).append(error)

    filtered = [
        row
        for row in rows_with_customer
        if _matches_search(row, search or "")
        and _matches_status(row, status)
        and _matches_quarter(row, quarter)
        and _matches_metric_filter(
            row,
            metric,
            errors_by_parent=errors_by_parent,
            date_from=date_from,
            date_to=date_to,
        )
    ]

    reverse = sort.endswith("_desc") or sort == "id_desc"
    sort_field = sort.replace("_desc", "").replace("_asc", "")
    filtered.sort(key=lambda t: _sort_key(t, sort_field), reverse=reverse)

    items: list[ChangeRequestOut] = []
    for row in filtered:
        linked = errors_by_parent.get(row.id, [])
        board_code_value = _extra(row).get("board_code")
        planned_date, _, quarter_label, planned_label = _task_plan_meta(row)
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
                plannedDate=planned_date,
                plannedLabel=planned_label,
                planQuarter=quarter_label,
                plannedRelease=_planned_release(row),
                createdAt=row.created_at,
                boardCode=str(board_code_value) if board_code_value else None,
                boardName=row.source_team or _board_name_by_code(str(board_code_value) if board_code_value else None),
                customerName=_customer_name(row),
                businessGoal=_business_goal(row),
                ectResourceReservation=_ect_resource_reservation(row),
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
        metrics=_compute_metrics(
            rows_with_customer,
            errors_by_parent=errors_by_parent,
            date_from=date_from,
            date_to=date_to,
        ),
        items=items,
        totalShown=len(items),
        availableStatuses=_collect_available_statuses(rows_with_customer),
        availableQuarters=_collect_available_quarters(rows_with_customer),
    )


def _boards_for_export(board_code: str | None) -> list[BoardConfig]:
    if is_all_boards(board_code) or not board_code:
        return list(BOARDS)
    board = board_by_code(board_code)
    return [board] if board else []


def _write_export_rows(writer: csv.writer, items: list[ChangeRequestOut]) -> None:
    for item in items:
        errors_text = "; ".join(f"{e.id}: {e.title}" for e in item.errors)
        writer.writerow(
            [
                item.number,
                item.title,
                item.status or "",
                item.boardColumn or "",
                item.startDate.isoformat() if item.startDate else "",
                item.releaseDate.isoformat() if item.releaseDate else "",
                item.plannedLabel or (item.plannedDate.isoformat() if item.plannedDate else ""),
                item.planQuarter or "",
                item.plannedRelease or "",
                ect_resource_reservation_label(item.ectResourceReservation),
                item.boardName or "",
                errors_text,
            ]
        )


def export_csv(db: Session, *, board_code: str | None = None) -> str:
    boards_to_export = _boards_for_export(board_code)

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
            "Планируемая дата",
            "План квартала",
            "Плановый релиз",
            "Бронь ресурса ЕЦТ",
            "Доска",
            "Ошибки",
        ]
    )

    for board in boards_to_export:
        single = load_change_requests(db, board_code=board.code)
        _write_export_rows(writer, single.items)
    return output.getvalue()
