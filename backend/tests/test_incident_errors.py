from datetime import date, datetime

from app.models import Task
from app.report_service import (
    BERCUT_BOARD_CODE,
    _incident_error_to_item,
    _is_incident_standalone_error,
    _matches_incident_error_row,
    _standalone_incident_errors,
)


def _error(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1251042",
        "title": "Incident error",
        "task_type": "error",
        "source_team": "BE Analytics",
        "source_status": "In Progress",
        "extra_json": {
            "board_code": BERCUT_BOARD_CODE,
            "incident_error": True,
            "tags": ["b2b_product"],
        },
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_is_incident_standalone_error() -> None:
    assert _is_incident_standalone_error(_error())
    assert not _is_incident_standalone_error(_error(parent_task_id=10))
    assert not _is_incident_standalone_error(
        _error(extra_json={"board_code": BERCUT_BOARD_CODE, "tags": ["b2b_product"]})
    )


def test_incident_error_visible_for_errors_metric_and_all() -> None:
    error = _error(created_at=datetime(2026, 5, 1, 12, 0, 0))
    assert _matches_incident_error_row(
        error,
        board_code=BERCUT_BOARD_CODE,
        metric=None,
        search=None,
        status=None,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 12, 31),
    )
    assert _matches_incident_error_row(
        error,
        board_code=BERCUT_BOARD_CODE,
        metric="errors",
        search=None,
        status=None,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 12, 31),
    )
    assert not _matches_incident_error_row(
        error,
        board_code=BERCUT_BOARD_CODE,
        metric="in_progress",
        search=None,
        status=None,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 12, 31),
    )


def test_incident_error_uses_created_at_when_start_date_missing() -> None:
    error = _error(created_at=datetime(2024, 1, 1, 12, 0, 0), start_date=None)
    assert not _matches_incident_error_row(
        error,
        board_code=BERCUT_BOARD_CODE,
        metric="errors",
        search=None,
        status=None,
        date_from=date(2026, 1, 1),
        date_to=date(2026, 12, 31),
    )


def test_incident_error_to_item_marks_row_type() -> None:
    item = _incident_error_to_item(_error())
    assert item.rowType == "error"
    assert item.number == "1251042"


def test_standalone_incident_errors_filters_linked() -> None:
    rows = [_error(), _error(external_id="2", parent_task_id=99)]
    assert len(_standalone_incident_errors(rows)) == 1
