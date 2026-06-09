from datetime import date

from app.models import Task
from app.report_service import _planned_date_upcoming_sort_key


def _task(external_id: str, planned_date: str | None, *, tbd: bool = False) -> Task:
    extra: dict = {}
    if tbd:
        extra["plan_quarter"] = "TBD"
        extra["planned_status"] = "TBD"
    elif planned_date is not None:
        extra["planned_date"] = planned_date
    return Task(
        id=1,
        external_id=external_id,
        title="Test",
        extra_json=extra,
    )


def test_planned_date_upcoming_sort_future_nearest_first() -> None:
    today = date(2026, 6, 9)
    tasks = [
        _task("3", "2026-07-01"),
        _task("1", "2026-06-15"),
        _task("2", "2026-06-20"),
    ]
    tasks.sort(key=lambda t: _planned_date_upcoming_sort_key(t, today=today))
    assert [t.external_id for t in tasks] == ["1", "2", "3"]


def test_planned_date_upcoming_sort_past_at_end() -> None:
    today = date(2026, 6, 9)
    tasks = [
        _task("past", "2026-01-01"),
        _task("future", "2026-06-15"),
        _task("today", "2026-06-09"),
    ]
    tasks.sort(key=lambda t: _planned_date_upcoming_sort_key(t, today=today))
    assert [t.external_id for t in tasks] == ["today", "future", "past"]


def test_planned_date_upcoming_sort_tbd_and_missing_before_past() -> None:
    today = date(2026, 6, 9)
    tasks = [
        _task("past", "2026-01-01"),
        _task("tbd", None, tbd=True),
        _task("future", "2026-06-15"),
        _task("empty", None),
    ]
    tasks.sort(key=lambda t: _planned_date_upcoming_sort_key(t, today=today))
    assert [t.external_id for t in tasks] == ["future", "tbd", "empty", "past"]
