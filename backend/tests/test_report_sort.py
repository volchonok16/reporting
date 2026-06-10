from datetime import date

from app.models import Task
from app.report_service import (
    _business_value_asc_sort_key,
    _business_value_desc_sort_key,
    _planned_date_upcoming_sort_key,
)


def _task(
    external_id: str,
    planned_date: str | None = None,
    *,
    tbd: bool = False,
    business_value: int | None = None,
) -> Task:
    extra: dict = {}
    if tbd:
        extra["plan_quarter"] = "TBD"
        extra["planned_status"] = "TBD"
    elif planned_date is not None:
        extra["planned_date"] = planned_date
    if business_value is not None:
        extra["business_value"] = business_value
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


def test_planned_date_upcoming_sort_past_before_tbd_and_empty() -> None:
    today = date(2026, 6, 9)
    tasks = [
        _task("past", "2026-01-01"),
        _task("tbd", None, tbd=True),
        _task("future", "2026-06-15"),
        _task("today", "2026-06-09"),
        _task("empty", None),
    ]
    tasks.sort(key=lambda t: _planned_date_upcoming_sort_key(t, today=today))
    assert [t.external_id for t in tasks] == ["today", "future", "past", "tbd", "empty"]


def test_business_value_asc_sort_filled_then_empty() -> None:
    tasks = [
        _task("empty", business_value=None),
        _task("35", business_value=35),
        _task("1", business_value=1),
        _task("10", business_value=10),
    ]
    tasks.sort(key=_business_value_asc_sort_key)
    assert [t.external_id for t in tasks] == ["1", "10", "35", "empty"]


def test_business_value_desc_sort_empty_then_largest() -> None:
    tasks = [
        _task("1", business_value=1),
        _task("empty", business_value=None),
        _task("35", business_value=35),
        _task("10", business_value=10),
    ]
    tasks.sort(key=_business_value_desc_sort_key)
    assert [t.external_id for t in tasks] == ["empty", "35", "10", "1"]
