from datetime import date, datetime

from app.config import settings
from app.models import Task
from app.tfs_client import parse_tfs_datetime


def _pilot_states_lower() -> set[str]:
    return {value.lower() for value in settings.pilot_state_list}


def _parse_transition_date(value: str | None) -> date | None:
    if not value:
        return None
    parsed = parse_tfs_datetime(value)
    return parsed.date() if parsed else None


def pilot_entered_in_period(
    task: Task,
    *,
    date_from: date | None,
    date_to: date | None,
) -> bool:
    """ЗНИ переведена в пилот в выбранный период (по истории updates TFS)."""
    if not date_from and not date_to:
        return False

    extra = task.extra_json if isinstance(task.extra_json, dict) else {}
    transitions = extra.get("pilot_transitions")
    if isinstance(transitions, list):
        for entry in transitions:
            if not isinstance(entry, dict):
                continue
            transition_date = _parse_transition_date(str(entry.get("at") or ""))
            if transition_date is None:
                continue
            if date_from and transition_date < date_from:
                continue
            if date_to and transition_date > date_to:
                continue
            return True

    # Fallback: текущий статус «пилот» и дата изменения в периоде
    status = (task.source_status or "").strip().lower()
    if status not in _pilot_states_lower():
        return False
    changed = task.updated_at.date() if task.updated_at else None
    if changed is None:
        return False
    if date_from and changed < date_from:
        return False
    if date_to and changed > date_to:
        return False
    return True


def count_launched(
    rows: list[Task],
    *,
    date_from: date | None,
    date_to: date | None,
) -> int:
    return sum(
        1 for row in rows if pilot_entered_in_period(row, date_from=date_from, date_to=date_to)
    )
