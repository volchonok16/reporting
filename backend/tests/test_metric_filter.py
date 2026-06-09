from datetime import date

from app.board_metrics import has_linked_errors, is_launching_soon
from app.models import Task
from app.report_service import _matches_metric_filter


def _zni(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1",
        "title": "Test",
        "task_type": "change_request",
        "source_team": "Digital Streams B2b",
        "extra_json": {"board_code": "digital_streams_b2b"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_metric_filter_launching_soon() -> None:
    task = _zni(source_status="UAT")
    today = date(2026, 6, 8)
    assert _matches_metric_filter(
        task,
        "launching_soon",
        errors_by_parent={},
        date_from=None,
        date_to=None,
    )
    assert not _matches_metric_filter(
        _zni(source_status="Development"),
        "launching_soon",
        errors_by_parent={},
        date_from=None,
        date_to=None,
    )


def test_metric_filter_completed() -> None:
    task = _zni(
        source_status="Closed",
        extra_json={
            "board_code": "digital_streams_b2b",
            "customer_name": "Иванов Иван",
            "closed_transitions": [{"at": "2026-05-01T10:00:00+00:00", "status": "Closed"}],
        },
    )
    assert _matches_metric_filter(
        task,
        "completed",
        errors_by_parent={},
        date_from=date(2026, 4, 1),
        date_to=date(2026, 6, 30),
    )
    assert not _matches_metric_filter(
        _zni(source_status="Closed"),
        "completed",
        errors_by_parent={},
        date_from=date(2026, 4, 1),
        date_to=date(2026, 6, 30),
    )


def test_metric_filter_errors() -> None:
    parent = _zni()
    parent.id = 10
    error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Err",
        task_type="error",
        source_team="Digital Streams B2b",
        parent_task_id=10,
    )
    errors_by_parent = {10: [error]}
    assert has_linked_errors(parent, errors_by_parent)
    assert _matches_metric_filter(
        parent,
        "errors",
        errors_by_parent=errors_by_parent,
        date_from=None,
        date_to=None,
    )
