from datetime import date

import pytest

from app.digital_plan_service import (
    has_uc_from_task,
    plan_period_from_tag,
    preserve_digital_plan_fields_in_extra,
)
from app.models import Task


def test_plan_period_from_tag_q3_q4() -> None:
    period_from, period_to = plan_period_from_tag("Q3-Q4'26", 2026)
    assert period_from == date(2026, 7, 1)
    assert period_to == date(2026, 12, 31)


def test_plan_period_from_tag_invalid() -> None:
    with pytest.raises(ValueError):
        plan_period_from_tag("invalid", 2026)


def test_preserve_digital_plan_fields_in_extra() -> None:
    new_extra: dict = {}
    preserve_digital_plan_fields_in_extra(new_extra, {"has_uc": True})
    assert new_extra["has_uc"] is True


def test_has_uc_from_task() -> None:
    task = Task(extra_json={"has_uc": True})
    assert has_uc_from_task(task) is True
    task.extra_json = {"has_uc": False}
    assert has_uc_from_task(task) is False
    task.extra_json = {}
    assert has_uc_from_task(task) is False
