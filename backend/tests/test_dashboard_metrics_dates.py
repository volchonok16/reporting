from datetime import date, datetime, timezone

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


def test_digital_launching_soon_ignores_start_date_range() -> None:
    old_uat = _zni(source_status="UAT", start_date=date(2024, 6, 1), external_id="970092")
    new_uat = _zni(source_status="UAT", start_date=date(2026, 4, 15), external_id="1172515")
    rows = [old_uat, new_uat]
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    metrics = _compute_metrics(
        rows,
        board_code="digital_streams_b2b",
        error_rows=[],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )

    assert metrics.launchingSoon == 2
    assert metrics.totalTasks == 2


def test_be_launching_soon_ignores_start_date_range_like_before() -> None:
    old_uat = _zni(
        source_status="UAT Prod",
        source_team="BE Analytics",
        extra_json={"board_code": "be_t2_team", "customer_name": "Иванов"},
        start_date=date(2024, 6, 1),
        external_id="1",
    )
    new_uat = _zni(
        source_status="UAT Prod",
        source_team="BE Analytics",
        extra_json={"board_code": "be_t2_team", "customer_name": "Петров"},
        start_date=date(2026, 4, 15),
        external_id="2",
    )
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    metrics = _compute_metrics(
        [old_uat, new_uat],
        board_code="be_t2_team",
        error_rows=[],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )

    assert metrics.launchingSoon == 2


def test_be_metric_uses_created_at_for_incident_errors_only() -> None:
    from app.report_service import _matches_incident_error_row

    dev = _zni(
        source_status="Development",
        source_team="BE Analytics",
        extra_json={"board_code": "be_t2_team", "customer_name": "Иванов"},
        start_date=None,
        created_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        external_id="1",
    )
    date_from = date(2026, 1, 1)
    date_to = date(2026, 6, 30)

    assert _matches_dashboard_row(
        dev,
        "in_progress",
        board_code="be_t2_team",
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )

    incident = Task(
        source_system_id=1,
        project_id=1,
        external_id="1251042",
        title="Incident",
        task_type="error",
        source_team="BE Analytics",
        created_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        extra_json={"board_code": "be_t2_team", "incident_error": True, "tags": ["b2b_product"]},
    )
    assert _matches_incident_error_row(
        incident,
        board_code="be_t2_team",
        metric="errors",
        search=None,
        status=None,
        date_from=date_from,
        date_to=date_to,
    )


def test_total_tasks_excludes_closed() -> None:
    open_task = _zni(source_status="UAT", external_id="1")
    closed_task = _zni(source_status="Closed", external_id="2")

    metrics = _compute_metrics(
        [open_task, closed_task],
        board_code="digital_streams_b2b",
        error_rows=[],
        errors_by_parent={},
        date_from=None,
        date_to=None,
    )
    assert metrics.totalTasks == 1


def test_total_tasks_and_default_table_use_start_date_range() -> None:
    old = _zni(start_date=date(2020, 1, 1), external_id="1")
    recent = _zni(start_date=date(2026, 4, 15), external_id="2")
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    assert _matches_dashboard_row(
        old,
        None,
        board_code="digital_streams_b2b",
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    ) is False
    assert _matches_dashboard_row(
        recent,
        "",
        board_code="digital_streams_b2b",
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )

    metrics = _compute_metrics(
        [old, recent],
        board_code="digital_streams_b2b",
        error_rows=[],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )
    assert metrics.totalTasks == 2


def test_digital_errors_count_ignores_start_date_filter() -> None:
    zni = _zni(start_date=date(2020, 1, 1), external_id="1")
    zni.id = 10
    error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Err",
        task_type="error",
        source_team="Digital Streams B2b",
        start_date=date(2020, 1, 1),
        parent_task_id=10,
    )
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)
    errors_by_parent = {10: [error]}

    metrics = _compute_metrics(
        [zni],
        board_code="digital_streams_b2b",
        error_rows=[error],
        errors_by_parent=errors_by_parent,
        date_from=date_from,
        date_to=date_to,
    )
    assert metrics.errorsCount == 1
    assert _matches_dashboard_row(
        zni,
        "errors",
        board_code="digital_streams_b2b",
        errors_by_parent=errors_by_parent,
        date_from=date_from,
        date_to=date_to,
    )


def test_be_errors_count_ignores_start_date_for_linked_zni_like_before() -> None:
    zni = _zni(
        start_date=date(2020, 1, 1),
        source_team="BE Analytics",
        extra_json={"board_code": "be_t2_team", "customer_name": "Иванов"},
        external_id="1",
    )
    zni.id = 10
    error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Err",
        task_type="error",
        source_team="BE Analytics",
        parent_task_id=10,
    )
    errors_by_parent = {10: [error]}
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    metrics = _compute_metrics(
        [zni],
        board_code="be_t2_team",
        error_rows=[error],
        errors_by_parent=errors_by_parent,
        date_from=date_from,
        date_to=date_to,
    )
    assert metrics.errorsCount == 1


def test_errors_count_ignores_unlinked_errors() -> None:
    zni = _zni(start_date=date(2020, 1, 1), external_id="1")

    metrics = _compute_metrics(
        [zni],
        board_code="digital_streams_b2b",
        error_rows=[],
        errors_by_parent={},
        date_from=None,
        date_to=None,
    )
    assert metrics.errorsCount == 0


def test_launched_metric_includes_closed_be_board_in_table() -> None:
    closed = _zni(
        source_status="Closed",
        source_team="BE Analytics",
        extra_json={"board_code": "be_t2_team", "customer_name": "Иванов"},
        start_date=date(2026, 2, 1),
    )
    date_from = date(2026, 1, 1)
    date_to = date(2026, 6, 30)

    metrics = _compute_metrics(
        [closed],
        board_code="be_t2_team",
        error_rows=[],
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )
    assert metrics.launched == 1
    assert _matches_dashboard_row(
        closed,
        "launched",
        board_code="be_t2_team",
        errors_by_parent={},
        date_from=date_from,
        date_to=date_to,
    )


def test_in_progress_metric_counts_development() -> None:
    dev = _zni(source_status="Development", external_id="1")
    uat = _zni(source_status="UAT", external_id="2")

    metrics = _compute_metrics(
        [dev, uat],
        board_code="digital_streams_b2b",
        error_rows=[],
        errors_by_parent={},
        date_from=None,
        date_to=None,
    )
    assert metrics.inProgress == 1


def test_errors_count_ignores_closed_errors() -> None:
    zni = _zni(start_date=date(2020, 1, 1), external_id="1")
    zni.id = 10
    open_error = Task(
        source_system_id=1,
        project_id=1,
        external_id="99",
        title="Open",
        task_type="error",
        source_status="Active",
        source_team="Digital Streams B2b",
        parent_task_id=10,
    )
    closed_error = Task(
        source_system_id=1,
        project_id=1,
        external_id="100",
        title="Closed",
        task_type="error",
        source_status="Closed",
        source_team="Digital Streams B2b",
        parent_task_id=10,
    )
    error_rows = active_errors([open_error, closed_error])
    errors_by_parent = {10: error_rows}

    metrics = _compute_metrics(
        [zni],
        board_code="digital_streams_b2b",
        error_rows=error_rows,
        errors_by_parent=errors_by_parent,
        date_from=None,
        date_to=None,
    )
    assert metrics.errorsCount == 1
