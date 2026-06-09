from datetime import date

from app.iteration_plan import PLAN_QUARTER_TBD
from app.models import Task
from app.report_service import _collect_available_quarters


def _zni(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1",
        "title": "Test",
        "task_type": "change_request",
        "source_team": "Digital Streams B2b",
        "extra_json": {"board_code": "digital_streams_b2b", "customer_name": "Иванов"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_available_quarters_current_year_only_and_no_tbd() -> None:
    year = date.today().year
    rows = [
        _zni(extra_json={"board_code": "digital_streams_b2b", "customer_name": "A", "plan_quarter": f"{year}-Q2"}),
        _zni(extra_json={"board_code": "digital_streams_b2b", "customer_name": "B", "plan_quarter": f"{year - 1}-Q4"}),
        _zni(extra_json={"board_code": "digital_streams_b2b", "customer_name": "C", "plan_quarter": PLAN_QUARTER_TBD}),
    ]
    options = _collect_available_quarters(rows)
    assert [item.key for item in options] == [f"{year}-Q2"]
    assert all(item.key != PLAN_QUARTER_TBD for item in options)
