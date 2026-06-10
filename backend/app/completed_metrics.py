from datetime import date
from typing import Any

from app.config import settings
from app.models import Task
from app.tfs_client import parse_tfs_datetime
from app.zni_description import tfs_identity_display_name

_PLAUSIBLE_TRANSITION_YEAR_MIN = 2000
_PLAUSIBLE_TRANSITION_YEAR_MAX = 2100


def _closed_states_lower() -> set[str]:
    return {value.lower() for value in settings.closed_state_list}


def is_plausible_transition_date(value: date) -> bool:
    return _PLAUSIBLE_TRANSITION_YEAR_MIN <= value.year <= _PLAUSIBLE_TRANSITION_YEAR_MAX


def _parse_transition_date(value: str | None) -> date | None:
    if not value:
        return None
    parsed = parse_tfs_datetime(value)
    if parsed is None:
        return None
    transition_date = parsed.date()
    if not is_plausible_transition_date(transition_date):
        return None
    return transition_date


def effective_closed_date(task: Task) -> date | None:
    """Дата закрытия ЗНИ: ClosedDate, иначе первая валидная дата из closed_transitions."""
    if task.closed_at:
        return task.closed_at.date()

    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    transitions = extra.get("closed_transitions")
    if not isinstance(transitions, list):
        return None

    valid_dates: list[date] = []
    for entry in transitions:
        if not isinstance(entry, dict):
            continue
        transition_date = _parse_transition_date(str(entry.get("at") or ""))
        if transition_date is not None:
            valid_dates.append(transition_date)
    if not valid_dates:
        return None
    return min(valid_dates)


def effective_closed_date_from_fields(fields: dict[str, Any]) -> date | None:
    closed = parse_tfs_datetime(fields.get("Microsoft.VSTS.Common.ClosedDate"))
    return closed.date() if closed else None


def _effective_period(
    date_from: date | None,
    date_to: date | None,
) -> tuple[date, date]:
    if date_from or date_to:
        start = date_from or date.min
        end = date_to or date.max
        return start, end
    today = date.today()
    return date(today.year, 1, 1), date(today.year, 12, 31)


def has_customer_name(task: Task) -> bool:
    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    value = extra.get("customer_name")
    if not value:
        return False
    return bool(tfs_identity_display_name(value))


def closed_entered_in_period(
    task: Task,
    *,
    date_from: date | None,
    date_to: date | None,
) -> bool:
    """ЗНИ переведена в Closed в выбранный период (по истории updates TFS)."""
    period_from, period_to = _effective_period(date_from, date_to)

    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    transitions = extra.get("closed_transitions")
    if isinstance(transitions, list):
        for entry in transitions:
            if not isinstance(entry, dict):
                continue
            transition_date = _parse_transition_date(str(entry.get("at") or ""))
            if transition_date is None:
                continue
            if transition_date < period_from:
                continue
            if transition_date > period_to:
                continue
            return True

    status = (task.source_status or "").strip().lower()
    if status not in _closed_states_lower():
        return False
    closed = effective_closed_date(task)
    if closed is None:
        return False
    if closed < period_from:
        return False
    if closed > period_to:
        return False
    return True


def is_completed(
    task: Task,
    *,
    date_from: date | None,
    date_to: date | None,
) -> bool:
    if not has_customer_name(task):
        return False
    return closed_entered_in_period(task, date_from=date_from, date_to=date_to)


def count_completed_rows(
    rows: list[Task],
    *,
    date_from: date | None,
    date_to: date | None,
) -> int:
    return sum(
        1 for row in rows if is_completed(row, date_from=date_from, date_to=date_to)
    )
