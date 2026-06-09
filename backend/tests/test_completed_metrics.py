from datetime import date, datetime, timezone

from app.completed_metrics import closed_entered_in_period, has_customer_name, is_completed
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
