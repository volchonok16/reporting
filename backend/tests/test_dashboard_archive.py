from datetime import date, datetime, timezone

from app.models import Task
from app.report_service import _is_dashboard_archived_zni


def _closed_zni(*, external_id: str, closed_year: int) -> Task:
    return Task(
        source_system_id=1,
        project_id=1,
        external_id=external_id,
        title="Test ZNI",
        task_type="change_request",
        source_status="Closed",
        source_team="Digital Streams B2b",
        closed_at=datetime(closed_year, 6, 15, tzinfo=timezone.utc),
        extra_json={"customer_name": "Иванов Иван"},
    )


def test_archived_closed_zni_hidden_from_dashboard_window() -> None:
    current_year = date.today().year
    archived = _closed_zni(external_id="1", closed_year=current_year - 2)
    visible = _closed_zni(external_id="2", closed_year=current_year)

    assert _is_dashboard_archived_zni(archived, visible_since_year=current_year)
    assert not _is_dashboard_archived_zni(visible, visible_since_year=current_year)


def test_open_zni_not_archived() -> None:
    row = Task(
        source_system_id=1,
        project_id=1,
        external_id="3",
        title="Open",
        task_type="change_request",
        source_status="UAT",
        source_team="Digital Streams B2b",
        extra_json={"customer_name": "Иванов Иван"},
    )
    assert not _is_dashboard_archived_zni(row, visible_since_year=date.today().year)
