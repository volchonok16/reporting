from datetime import date

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


def test_launching_soon_metric_respects_start_date_range() -> None:
    in_range_uat = _zni(source_status="UAT", start_date=date(2026, 4, 15))
    out_of_range_uat = _zni(source_status="UAT", start_date=date(2026, 1, 10), external_id="2")
    rows = [in_range_uat, out_of_range_uat]
    date_from = date(2026, 4, 1)
    date_to = date(2026, 6, 30)

    metrics = _compute_metrics(rows, errors_by_parent={}, date_from=date_from, date_to=date_to)

    assert metrics.launchingSoon == 1
    assert sum(
        1
        for row in rows
        if _matches_dashboard_row(
            row,
            "launching_soon",
            errors_by_parent={},
            date_from=date_from,
            date_to=date_to,
        )
    ) == metrics.launchingSoon
