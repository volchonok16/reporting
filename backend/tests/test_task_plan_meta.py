from datetime import date

from app.models import Task
from app.report_service import _task_plan_meta


def _zni(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1071033",
        "title": "Test",
        "task_type": "change_request",
        "source_team": "Digital Streams B2b",
        "extra_json": {"board_code": "digital_streams_b2b", "iteration_path": r"Tele2\Общие"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_planned_date_falls_back_to_target_date() -> None:
    task = _zni(release_date=date(2025, 12, 3))
    planned, quarter_key, quarter_label, planned_label = _task_plan_meta(task)
    assert planned == date(2025, 12, 3)
    assert quarter_key == "2025-Q4"
    assert quarter_label == "Q4 2025"
    assert planned_label is None


def test_iteration_date_has_priority_over_target_date() -> None:
    task = _zni(
        release_date=date(2025, 12, 3),
        extra_json={
            "board_code": "digital_streams_b2b",
            "iteration_path": r"Tele2\Общие\Digital\2026\2026.08.11.0-R",
            "planned_date": "2026-08-11",
            "plan_quarter": "2026-Q3",
        },
    )
    planned, quarter_key, _, _ = _task_plan_meta(task)
    assert planned == date(2026, 8, 11)
    assert quarter_key == "2026-Q3"
