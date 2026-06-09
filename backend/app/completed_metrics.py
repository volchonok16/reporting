from datetime import date

from app.config import settings
from app.models import Task
from app.tfs_client import parse_tfs_datetime
from app.zni_description import tfs_identity_display_name


def _closed_states_lower() -> set[str]:
    return {value.lower() for value in settings.closed_state_list}


def _parse_transition_date(value: str | None) -> date | None:
    if not value:
        return None
    parsed = parse_tfs_datetime(value)
    return parsed.date() if parsed else None


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
    closed = task.closed_at.date() if task.closed_at else None
    changed = closed or (task.updated_at.date() if task.updated_at else None)
    if changed is None:
        return False
    if changed < period_from:
        return False
    if changed > period_to:
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
