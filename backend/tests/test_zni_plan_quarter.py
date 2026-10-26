from datetime import date

import pytest

from app.zni_plan_quarter import (
    format_plan_quarter_label,
    normalize_plan_quarter,
    plan_quarter_is_overdue,
)


def test_normalize_plan_quarter_accepts_common_forms() -> None:
    assert normalize_plan_quarter("2026-q1") == "2026-Q1"
    assert normalize_plan_quarter("q2 2026") == "2026-Q2"
    assert normalize_plan_quarter("  ") is None
    assert normalize_plan_quarter(None) is None


def test_normalize_plan_quarter_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        normalize_plan_quarter("2026-Q5")


def test_open_zni_is_overdue_after_declared_quarter() -> None:
    assert plan_quarter_is_overdue(
        "2026-Q1",
        closed_on=None,
        today=date(2026, 4, 1),
    )
    assert not plan_quarter_is_overdue(
        "2026-Q1",
        closed_on=None,
        today=date(2026, 3, 31),
    )


def test_closed_inside_quarter_is_not_overdue() -> None:
    assert not plan_quarter_is_overdue(
        "2026-Q1",
        closed_on=date(2026, 3, 15),
        today=date(2026, 7, 1),
    )
    assert plan_quarter_is_overdue(
        "2026-Q1",
        closed_on=date(2026, 4, 2),
        today=date(2026, 7, 1),
    )


def test_empty_plan_is_not_overdue() -> None:
    assert not plan_quarter_is_overdue(None, closed_on=None, today=date(2026, 8, 1))
    assert format_plan_quarter_label("2026-Q3") == "Q3 2026"
