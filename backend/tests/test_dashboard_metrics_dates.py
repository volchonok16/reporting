from datetime import date

from app.models import Task
from app.report_service import _compute_metrics, _matches_metric_filter


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

    metrics = _compute_metrics(rows, errors_by_parent={}, date_from=date_from, date_to=date_to)

    assert metrics.launchingSoon == 2
    assert metrics.totalTasks == 2


def test_default_table_is_not_limited_by_start_date() -> None:
    old = _zni(start_date=date(2020, 1, 1), external_id="1")
    recent = _zni(start_date=date(2026, 4, 15), external_id="2")
    date_from = date(2026, 1, 1)
    date_to = date(2026, 12, 31)

    assert _matches_metric_filter(old, None, errors_by_parent={}, date_from=date_from, date_to=date_to)
    assert _matches_metric_filter(recent, "", errors_by_parent={}, date_from=date_from, date_to=date_to)

    metrics = _compute_metrics([old, recent], errors_by_parent={}, date_from=date_from, date_to=date_to)
    assert metrics.totalTasks == 2
