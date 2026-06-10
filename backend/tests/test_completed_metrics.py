from datetime import date, datetime, timezone

from app.completed_metrics import (
    closed_entered_in_period,
    effective_closed_date,
    has_customer_name,
    is_completed,
)
from app.models import Task


def _zni(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1",
        "title": "Test",
        "task_type": "change_request",
        "source_team": "Digital Streams B2b",
        "source_status": "Closed",
        "extra_json": {
            "board_code": "digital_streams_b2b",
            "customer_name": "Иванов Иван",
        },
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_completed_requires_customer_name() -> None:
    task = _zni(extra_json={"board_code": "digital_streams_b2b"})
    assert not has_customer_name(task)
    assert not is_completed(
        task,
        date_from=date(2026, 4, 1),
        date_to=date(2026, 6, 30),
    )


def test_completed_uses_closed_transition_history() -> None:
    task = _zni(
        extra_json={
            "board_code": "digital_streams_b2b",
            "customer_name": "Иванов Иван",
            "closed_transitions": [{"at": "2026-05-15T10:00:00+00:00", "status": "Closed"}],
        }
    )
    assert is_completed(
        task,
        date_from=date(2026, 4, 1),
        date_to=date(2026, 6, 30),
    )
    assert not is_completed(
        task,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 3, 31),
    )


def test_completed_fallback_uses_closed_at() -> None:
    task = _zni(
        closed_at=datetime(2026, 5, 20, 12, 0, tzinfo=timezone.utc),
    )
    assert closed_entered_in_period(
        task,
        date_from=date(2026, 4, 1),
        date_to=date(2026, 6, 30),
    )


def test_completed_ignores_invalid_transition_year() -> None:
    task = _zni(
        closed_at=datetime(2025, 8, 28, 7, 43, 39, tzinfo=timezone.utc),
        extra_json={
            "board_code": "digital_streams_b2b",
            "customer_name": "Иванов Иван",
            "closed_transitions": [{"at": "9999-01-01T00:00:00+00:00", "status": "Closed"}],
        },
    )
    assert effective_closed_date(task) == date(2025, 8, 28)
    assert not is_completed(task, date_from=date(2026, 1, 1), date_to=date(2026, 12, 31))
    assert is_completed(task, date_from=date(2025, 1, 1), date_to=date(2025, 12, 31))


def test_completed_does_not_use_updated_at_without_closed_at() -> None:
    task = _zni(
        closed_at=None,
        updated_at=datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc),
        extra_json={"board_code": "digital_streams_b2b", "customer_name": "Иванов Иван"},
    )
    assert not closed_entered_in_period(
        task,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 12, 31),
    )
