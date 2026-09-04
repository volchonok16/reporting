from unittest.mock import MagicMock

from app.sync_service import normalize_iteration_path, upsert_task


def test_normalize_iteration_path() -> None:
    assert normalize_iteration_path(None) is None
    assert normalize_iteration_path("") is None
    assert normalize_iteration_path("  ") is None
    assert normalize_iteration_path(r" Tele2\DocOut\2026_Q3_DoC ") == r"Tele2\DocOut\2026_Q3_DoC"
    assert len(normalize_iteration_path("x" * 600) or "") == 500


def test_upsert_task_writes_iteration_path() -> None:
    db = MagicMock()
    result = MagicMock()
    result.scalar_one.return_value = 42
    db.execute.return_value = result

    task_id = upsert_task(
        db,
        source_system_id=1,
        project_id=1,
        team_id=1,
        external_id="1333714",
        title="Test",
        task_type="change_request",
        source_status="Active",
        source_team="DocOut",
        created_at=None,
        updated_at=None,
        start_date=None,
        release_date=None,
        closed_at=None,
        parent_task_id=None,
        external_url=None,
        extra_json={"iteration_path": r"Tele2\DocOut\2026_Q3_DoC"},
        iteration_path=r" Tele2\DocOut\2026_Q3_DoC ",
    )

    assert task_id == 42
    stmt = db.execute.call_args[0][0]
    compiled = str(stmt.compile(compile_kwargs={"literal_binds": False}))
    assert "iteration_path" in compiled.lower()
