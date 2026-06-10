from datetime import date

from app.models import Task
from app.report_service import (
    _collect_available_statuses,
    _is_closed_zni,
    _matches_closed_table_visibility,
)


def _zni(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1",
        "title": "Test",
        "task_type": "change_request",
        "source_team": "Digital Streams B2b",
        "extra_json": {
            "board_code": "digital_streams_b2b",
            "customer_name": "Иванов Иван",
        },
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_is_closed_zni_by_workflow_status() -> None:
    assert _is_closed_zni(_zni(source_status="Closed"))
    assert not _is_closed_zni(_zni(source_status="UAT"))


def test_closed_hidden_from_table_without_completed_metric() -> None:
    closed = _zni(source_status="Closed")
    assert not _matches_closed_table_visibility(closed, None)
    assert not _matches_closed_table_visibility(closed, "launching_soon")
    assert _matches_closed_table_visibility(closed, "completed")


def test_available_statuses_exclude_closed() -> None:
    rows = [
        _zni(source_status="UAT"),
        _zni(source_status="Closed", extra_json={"board_code": "digital_streams_b2b", "customer_name": "A"}),
        _zni(
            source_status="Development",
            extra_json={"board_code": "digital_streams_b2b", "customer_name": "B", "board_column": "Closed"},
        ),
    ]
    assert _collect_available_statuses(rows) == ["Development", "UAT"]
