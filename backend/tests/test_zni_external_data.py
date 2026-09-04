from unittest.mock import MagicMock
from datetime import date

from app.models import Task, ZniExternalData
from app.zni_external_data_service import update_zni_external_data


def _task() -> Task:
    return Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"board_code": "digital_streams_b2b"},
    )


def test_update_zni_external_data_creates_row() -> None:
    task = _task()
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = None

    updated = update_zni_external_data(
        db,
        external_id="1115252",
        priority="  высокий  ",
        set_priority=True,
        commercial_effect="рост ARPU",
        set_commercial_effect=True,
        desired_date=date(2026, 9, 1),
        set_desired_date=True,
        comment="  ждём согласование  ",
        set_comment=True,
    )

    assert updated is task
    added = db.add.call_args[0][0]
    assert isinstance(added, ZniExternalData)
    assert added.priority == "высокий"
    assert added.commercial_effect == "рост ARPU"
    assert added.desired_date == date(2026, 9, 1)
    assert added.comment == "ждём согласование"
    db.commit.assert_called_once()


def test_update_zni_external_data_clears_field() -> None:
    task = _task()
    existing = ZniExternalData(task_id=1, priority="высокий", commercial_effect="рост")
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = existing

    update_zni_external_data(db, external_id="1115252", priority="  ", set_priority=True)

    assert existing.priority is None
    assert existing.commercial_effect == "рост"


def test_update_zni_external_data_missing_zni() -> None:
    db = MagicMock()
    db.scalar.return_value = None
    try:
        update_zni_external_data(db, external_id="0", set_priority=True, priority="1")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "не найден" in str(exc)


def test_actual_period_allowed_in_uat() -> None:
    task = _task()
    task.source_status = "UAT"
    existing = ZniExternalData(task_id=1)
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = existing

    update_zni_external_data(
        db,
        external_id="1115252",
        actual_period=" 2026 Q3 ",
        set_actual_period=True,
        can_manage_org=True,
    )

    assert existing.actual_period == "2026 Q3"


def test_actual_period_allowed_by_board_column() -> None:
    task = _task()
    task.source_status = "Development"
    task.extra_json = {**task.extra_json, "board_column": "Pilot"}
    existing = ZniExternalData(task_id=1)
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = existing

    update_zni_external_data(
        db,
        external_id="1115252",
        actual_period="август",
        set_actual_period=True,
        can_manage_org=True,
    )

    assert existing.actual_period == "август"


def test_actual_period_blocked_outside_allowed_status() -> None:
    task = _task()
    task.source_status = "Development"
    existing = ZniExternalData(task_id=1, actual_period="старое")
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = existing

    try:
        update_zni_external_data(
            db,
            external_id="1115252",
            actual_period="Q4",
            set_actual_period=True,
            can_manage_org=True,
        )
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "Фактическая дата" in str(exc)
    assert existing.actual_period == "старое"


def test_actual_period_requires_admin() -> None:
    task = _task()
    task.source_status = "UAT"
    existing = ZniExternalData(task_id=1, actual_period="старое")
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = existing

    try:
        update_zni_external_data(
            db,
            external_id="1115252",
            actual_period="Q4",
            set_actual_period=True,
            can_manage_org=False,
        )
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "администратор" in str(exc)
    assert existing.actual_period == "старое"


def test_update_zni_external_data_sets_category() -> None:
    from app.models import ZniCategory

    task = _task()
    existing = ZniExternalData(task_id=1)
    category = ZniCategory(id=7, name="Флайты", is_active=True)
    db = MagicMock()
    db.scalar.return_value = task
    db.get.side_effect = lambda model, key: existing if model is ZniExternalData else category

    update_zni_external_data(
        db,
        external_id="1115252",
        category_id=7,
        set_category_id=True,
    )

    assert existing.category_id == 7


def test_update_zni_external_data_clears_category() -> None:
    task = _task()
    existing = ZniExternalData(task_id=1, category_id=7)
    db = MagicMock()
    db.scalar.return_value = task
    db.get.return_value = existing

    update_zni_external_data(
        db,
        external_id="1115252",
        category_id=None,
        set_category_id=True,
    )

    assert existing.category_id is None
