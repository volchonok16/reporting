from datetime import date, datetime, timezone

from app.boards import BoardConfig, board_by_code, boards_for_sync
from app.models import Task
from app.sync_service import (
    _board_scope_source_teams,
    is_closed_before_current_year,
    should_skip_closed_zni,
    task_in_board_sync_scope,
)


def _closed_task(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "1",
        "title": "Test",
        "task_type": "change_request",
        "source_status": "Closed",
        "source_team": "B2B Product",
        "extra_json": {"board_code": "b2b_product_core"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_should_skip_closed_zni_from_previous_year() -> None:
    fields = {
        "System.State": "Closed",
        "Microsoft.VSTS.Common.ClosedDate": "2025-08-28T07:43:39.227Z",
        "System.ChangedDate": "2025-08-28T07:43:45.977Z",
    }
    assert should_skip_closed_zni(fields)


def test_should_not_skip_closed_zni_from_current_year() -> None:
    fields = {
        "System.State": "Closed",
        "Microsoft.VSTS.Common.ClosedDate": f"{date.today().year}-03-15T10:00:00Z",
        "System.ChangedDate": f"{date.today().year}-03-15T10:00:00Z",
    }
    assert not should_skip_closed_zni(fields)


def test_board_scope_source_teams_isolated_per_board() -> None:
    esb = board_by_code("esb_analytics")
    be = board_by_code("be_t2_team")
    core = board_by_code("b2b_product_core")
    assert esb is not None and be is not None and core is not None

    assert "BE Analytics" not in _board_scope_source_teams(esb)
    assert "BE Analytics" in _board_scope_source_teams(be)
    assert "BE-T2 Team" in _board_scope_source_teams(be)
    assert "BE-T2 Team" not in _board_scope_source_teams(core)


def _crm_area(code: str, area_path: str) -> BoardConfig:
    return BoardConfig(
        code=code,
        name="CRM&DocOut",
        display_name="CRM",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path=area_path,
    )


def test_shared_alias_prune_keeps_sibling_area_path() -> None:
    crm = _crm_area("crm", r"Tele2\CRM\Prometheus")
    docout = _crm_area("docout", r"Tele2\CRM\CRM Team DoC")
    boards = [crm, docout]
    assert {board.code for board in boards_for_sync("crm", boards)} == {"crm", "docout"}
    assert {board.area_path for board in boards_for_sync("crm", boards)} == {
        r"Tele2\CRM\Prometheus",
        r"Tele2\CRM\CRM Team DoC",
    }

    crm_task = _closed_task(
        external_id="100",
        source_team="CRM&DocOut",
        extra_json={"board_code": "crm"},
    )
    docout_task = _closed_task(
        external_id="200",
        source_team="CRM&DocOut",
        extra_json={"board_code": "docout"},
    )

    assert task_in_board_sync_scope(crm_task, crm)
    assert not task_in_board_sync_scope(crm_task, docout)
    assert task_in_board_sync_scope(docout_task, docout)
    assert not task_in_board_sync_scope(docout_task, crm)


def test_legacy_task_without_board_code_still_matches_source_team() -> None:
    core = board_by_code("b2b_product_core")
    assert core is not None
    legacy = _closed_task(extra_json={})
    assert task_in_board_sync_scope(legacy, core)
    esb = board_by_code("esb_analytics")
    assert esb is not None
    assert not task_in_board_sync_scope(legacy, esb)


def test_is_closed_before_current_year() -> None:
    current_year = date.today().year
    old_task = _closed_task(
        external_id="999516",
        closed_at=datetime(current_year - 1, 8, 28, tzinfo=timezone.utc),
    )
    fresh_task = _closed_task(
        external_id="100001",
        closed_at=datetime(current_year, 3, 1, tzinfo=timezone.utc),
    )
    open_task = _closed_task(external_id="100002", source_status="UAT")

    assert is_closed_before_current_year(old_task, current_year=current_year)
    assert not is_closed_before_current_year(fresh_task, current_year=current_year)
    assert not is_closed_before_current_year(open_task, current_year=current_year)
