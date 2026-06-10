"""Метрики дашборда с правилами по доскам."""
from __future__ import annotations

from datetime import date, timedelta

from app.boards import BOARDS, BoardConfig
from app.config import settings
from app.models import Task
from app.completed_metrics import count_completed_rows, is_completed
from app.pilot_metrics import pilot_entered_in_period

_BOARDS_BY_CODE = {board.code: board for board in BOARDS}
_BOARDS_BY_NAME = {board.name: board for board in BOARDS}
_BOARDS_BY_DISPLAY = {board.display_name: board for board in BOARDS}


def board_for_task(task: Task) -> BoardConfig | None:
    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    code = extra.get("board_code")
    if isinstance(code, str) and code in _BOARDS_BY_CODE:
        return _BOARDS_BY_CODE[code]
    team = task.source_team or ""
    return _BOARDS_BY_NAME.get(team) or _BOARDS_BY_DISPLAY.get(team)


def task_status_tokens(task: Task) -> set[str]:
    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    tokens: set[str] = set()
    for raw in (extra.get("board_column"), task.source_status):
        if raw and str(raw).strip():
            tokens.add(str(raw).strip().casefold())
    return tokens


def matches_board_states(task: Task, states: tuple[str, ...]) -> bool:
    if not states:
        return False
    allowed = {state.casefold() for state in states}
    return bool(task_status_tokens(task) & allowed)


def task_triage_value(task: Task) -> str | None:
    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    triage = extra.get("triage")
    if triage in (None, ""):
        return None
    return str(triage).strip()


def matches_board_triage(task: Task, triage_values: tuple[str, ...]) -> bool:
    if not triage_values:
        return False
    triage = task_triage_value(task)
    if not triage:
        return False
    allowed = {value.casefold() for value in triage_values}
    return triage.casefold() in allowed


def is_launching_soon(task: Task, *, today: date, horizon: date) -> bool:
    board = board_for_task(task)
    if board and (board.launching_soon_states or board.launching_soon_triage_values):
        state_match = matches_board_states(task, board.launching_soon_states)
        triage_match = matches_board_triage(task, board.launching_soon_triage_values)
        return state_match or triage_match
    return bool(
        task.release_date
        and today <= task.release_date <= horizon
        and task.closed_at is None
    )


def is_launched(task: Task, *, date_from: date | None, date_to: date | None) -> bool:
    board = board_for_task(task)
    if board and board.launched_states:
        return matches_board_states(task, board.launched_states)
    return pilot_entered_in_period(task, date_from=date_from, date_to=date_to)


def count_launching_soon(
    rows: list[Task],
    *,
    today: date | None = None,
    horizon: date | None = None,
) -> int:
    today_value = today or date.today()
    horizon_value = horizon or (today_value + timedelta(days=settings.launching_soon_days))
    return sum(
        1 for row in rows if is_launching_soon(row, today=today_value, horizon=horizon_value)
    )


def count_launched_rows(
    rows: list[Task],
    *,
    date_from: date | None,
    date_to: date | None,
) -> int:
    return sum(1 for row in rows if is_launched(row, date_from=date_from, date_to=date_to))


def _closed_states_lower() -> set[str]:
    return {value.lower() for value in settings.closed_state_list}


def is_closed_error(task: Task) -> bool:
    """Ошибка в финальном workflow-статусе (по умолчанию Closed) — не учитываем в метрике и выгрузке."""
    status = (task.source_status or "").strip().casefold()
    return bool(status and status in _closed_states_lower())


def active_errors(errors: list[Task]) -> list[Task]:
    return [error for error in errors if not is_closed_error(error)]


def has_linked_errors(task: Task, errors_by_parent: dict[int, list[Task]]) -> bool:
    return bool(active_errors(errors_by_parent.get(task.id, [])))
