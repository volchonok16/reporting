from datetime import date

from app.models import Task
from app.report_service import (
    _build_errors_by_parent,
    _collect_available_statuses,
    _compute_metrics,
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


def test_build_errors_by_parent_uses_parent_zni_id_fallback() -> None:
    zni = _zni(external_id="12345")
    zni.id = 10
    error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Err",
        task_type="error",
        source_team="Digital Streams B2b",
        extra_json={"parent_zni_id": 12345},
    )

    errors_by_parent = _build_errors_by_parent([zni], [error])

    assert errors_by_parent == {10: [error]}


def test_errors_count_uses_parent_zni_id_fallback() -> None:
    zni = _zni(external_id="12345", source_status="UAT")
    zni.id = 10
    error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Err",
        task_type="error",
        source_status="Active",
        source_team="Digital Streams B2b",
        extra_json={"parent_zni_id": 12345},
    )

    metrics = _compute_metrics(
        [zni],
        error_rows=[error],
        errors_by_parent=_build_errors_by_parent([zni], [error]),
        date_from=None,
        date_to=None,
    )
    assert metrics.errorsCount == 1


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
