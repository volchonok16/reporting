from datetime import date

from app.board_metrics import active_errors
from app.models import Task
from app.report_service import _compute_metrics, _matches_dashboard_row


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


def test_launching_soon_ignores_start_date_range() -> None:
    old_uat = _zni(source_status="UAT", start_date=date(2024, 6, 1), external_id="970092")
    new_uat = _zni(source_status="UAT", start_date=date(2026, 4, 15), external_id="1172515")
    rows = [old_uat, new_uat]
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    metrics = _compute_metrics(
        rows,
        error_rows=[],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )

    assert metrics.launchingSoon == 2
    assert metrics.totalTasks == 2


def test_total_tasks_and_default_table_use_start_date_range() -> None:
    old = _zni(start_date=date(2020, 1, 1), external_id="1")
    recent = _zni(start_date=date(2026, 4, 15), external_id="2")
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    assert _matches_dashboard_row(
        old, None, errors_by_parent={}, date_from=date_from, date_to=date_to
    ) is False
    assert _matches_dashboard_row(
        recent, "", errors_by_parent={}, date_from=date_from, date_to=date_to
    )

    metrics = _compute_metrics(
        [old, recent],
        error_rows=[],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )
    assert metrics.totalTasks == 2


def test_errors_count_includes_all_board_errors_without_start_date_filter() -> None:
    zni = _zni(start_date=date(2020, 1, 1), external_id="1")
    error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Err",
        task_type="error",
        source_team="Digital Streams B2b",
        start_date=date(2020, 1, 1),
    )
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    metrics = _compute_metrics(
        [zni],
        error_rows=[error],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )
    assert metrics.errorsCount == 1


def test_errors_count_ignores_closed_errors() -> None:
    zni = _zni(start_date=date(2020, 1, 1), external_id="1")
    open_error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Open",
        task_type="error",
        source_status="Active",
        source_team="Digital Streams B2b",
    )
    closed_error = Task(
        source_system_id=1,
        project_id=1,
        external_id="100",
        title="Closed",
        task_type="error",
        source_status="Closed",
        source_team="Digital Streams B2b",
    )
    error_rows = active_errors([open_error, closed_error])

    metrics = _compute_metrics(
        [zni],
        error_rows=error_rows,
        errors_by_parent={},
        date_from=None,
        date_to=None,
    )
    assert metrics.errorsCount == 1
