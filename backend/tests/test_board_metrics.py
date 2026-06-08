from datetime import date

from app.board_metrics import count_launched_rows, count_launching_soon, is_launched, is_launching_soon
from app.models import Task


def _task(
    *,
    board_code: str,
    source_team: str,
    source_status: str | None = None,
    board_column: str | None = None,
    release_date: date | None = None,
) -> Task:
    return Task(
        source_system_id=1,
        project_id=1,
        external_id="1",
        title="Test",
        task_type="change_request",
        source_team=source_team,
        source_status=source_status,
        release_date=release_date,
        extra_json={
            "board_code": board_code,
            "board_column": board_column,
        },
    )


def test_digital_uat_is_launching_soon() -> None:
    task = _task(
        board_code="digital_streams_b2b",
        source_team="Digital Streams B2b",
        source_status="UAT",
    )
    today = date(2026, 6, 8)
    assert is_launching_soon(task, today=today, horizon=today)
    assert count_launching_soon([task], today=today, horizon=today) == 1


def test_digital_pilot_is_launched() -> None:
    task = _task(
        board_code="digital_streams_b2b",
        source_team="Digital Streams B2b",
        source_status="Pilot",
    )
    assert is_launched(task, date_from=None, date_to=None)
    assert count_launched_rows([task], date_from=None, date_to=None) == 1


def test_be_analytics_uses_release_date_for_launching_soon() -> None:
    today = date(2026, 6, 8)
    horizon = date(2026, 7, 8)
    soon = _task(
        board_code="be_t2_team",
        source_team="BE Analytics",
        source_status="Development",
        release_date=date(2026, 6, 20),
    )
    later = _task(
        board_code="be_t2_team",
        source_team="BE Analytics",
        source_status="Development",
        release_date=date(2026, 12, 1),
    )
    assert is_launching_soon(soon, today=today, horizon=horizon)
    assert not is_launching_soon(later, today=today, horizon=horizon)
