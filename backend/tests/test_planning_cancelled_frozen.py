from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.planning_models import (
    PROJECT_STATUS_CANCELLED,
    PROJECT_STATUS_FROZEN,
    PROJECT_STATUS_IN_PROGRESS,
)
from app.planning_service import (
    _apply_status_side_effects,
    _clamp_allocation_dates_for_project,
    _resolve_project_status,
    _validate_status_dates,
)


def test_resolve_status_keeps_cancelled_and_frozen_over_actual_end() -> None:
    assert (
        _resolve_project_status(
            PROJECT_STATUS_CANCELLED,
            date(2026, 1, 1),
            cancelled_at=date(2026, 1, 2),
        )
        == PROJECT_STATUS_CANCELLED
    )
    assert (
        _resolve_project_status(
            PROJECT_STATUS_FROZEN,
            date(2026, 1, 1),
            freeze_until_date=date(2026, 3, 1),
        )
        == PROJECT_STATUS_FROZEN
    )
    assert _resolve_project_status(PROJECT_STATUS_IN_PROGRESS, date(2026, 1, 1)) == PROJECT_STATUS_COMPLETED


def test_validate_status_dates_requires_fields() -> None:
    with pytest.raises(HTTPException):
        _validate_status_dates(SimpleNamespace(status=PROJECT_STATUS_CANCELLED, cancelled_at=None))
    with pytest.raises(HTTPException):
        _validate_status_dates(SimpleNamespace(status=PROJECT_STATUS_FROZEN, freeze_until_date=None))
    _validate_status_dates(
        SimpleNamespace(status=PROJECT_STATUS_CANCELLED, cancelled_at=date(2026, 2, 1))
    )


def test_freeze_extends_planned_end() -> None:
    project = SimpleNamespace(
        status=PROJECT_STATUS_FROZEN,
        cancelled_at=date(2026, 1, 1),
        freeze_until_date=date(2026, 6, 1),
        planned_end_date=date(2026, 4, 1),
    )
    _apply_status_side_effects(project)
    assert project.cancelled_at is None
    assert project.planned_end_date == date(2026, 6, 1)


def test_clamp_allocation_respects_freeze_until(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.planning_service._project_completion_cutoff",
        lambda _db, _pid: None,
    )
    monkeypatch.setattr(
        "app.planning_service._project_freeze_until",
        lambda _db, _pid: date(2026, 3, 10),
    )
    start, end = _clamp_allocation_dates_for_project(
        MagicMock(), 1, date(2026, 3, 1), date(2026, 3, 20)
    )
    assert start == date(2026, 3, 11)
    assert end == date(2026, 3, 20)

    with pytest.raises(HTTPException):
        _clamp_allocation_dates_for_project(
            MagicMock(), 1, date(2026, 3, 1), date(2026, 3, 5)
        )


def test_clamp_allocation_respects_cancelled_cutoff(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.planning_service._project_completion_cutoff",
        lambda _db, _pid: date(2026, 2, 15),
    )
    monkeypatch.setattr(
        "app.planning_service._project_freeze_until",
        lambda _db, _pid: None,
    )
    start, end = _clamp_allocation_dates_for_project(
        MagicMock(), 1, date(2026, 2, 1), date(2026, 3, 1)
    )
    assert start == date(2026, 2, 1)
    assert end == date(2026, 2, 15)
