from unittest.mock import MagicMock

from app.models import Task
from app.roadmap_priority_service import (
    preserve_roadmap_priority_in_extra,
    roadmap_comment_from_task,
    roadmap_priority_from_task,
    update_roadmap_comment,
    update_roadmap_priority,
)


def test_roadmap_priority_from_task() -> None:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"roadmap_priority": "red"},
    )
    assert roadmap_priority_from_task(task) == "red"

    task.extra_json = {"roadmap_priority": "invalid"}
    assert roadmap_priority_from_task(task) is None


def test_update_roadmap_priority_sets_value() -> None:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"board_code": "digital_streams_b2b"},
    )
    db = MagicMock()
    db.scalar.return_value = task

    updated = update_roadmap_priority(db, external_id="1115252", priority="yellow")
    assert updated.extra_json["roadmap_priority"] == "yellow"
    db.commit.assert_called_once()


def test_preserve_roadmap_priority_in_extra() -> None:
    new_extra: dict[str, str] = {"board_code": "digital_streams_b2b"}
    preserve_roadmap_priority_in_extra(new_extra, {"roadmap_priority": "green"})
    assert new_extra["roadmap_priority"] == "green"

    new_extra = {"board_code": "digital_streams_b2b"}
    preserve_roadmap_priority_in_extra(new_extra, {"roadmap_priority": "invalid"})
    assert "roadmap_priority" not in new_extra

    preserve_roadmap_priority_in_extra(new_extra, None)
    assert "roadmap_priority" not in new_extra


def test_preserve_roadmap_comment_in_extra() -> None:
    new_extra: dict[str, str] = {"board_code": "digital_streams_b2b"}
    preserve_roadmap_priority_in_extra(new_extra, {"roadmap_comment": "  ждём API  "})
    assert new_extra["roadmap_comment"] == "ждём API"

    new_extra = {"board_code": "digital_streams_b2b"}
    preserve_roadmap_priority_in_extra(new_extra, {"roadmap_comment": "   "})
    assert "roadmap_comment" not in new_extra


def test_update_roadmap_priority_clears_value() -> None:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"roadmap_priority": "green"},
    )
    db = MagicMock()
    db.scalar.return_value = task

    updated = update_roadmap_priority(db, external_id="1115252", priority=None)
    assert "roadmap_priority" not in (updated.extra_json or {})


def test_roadmap_comment_from_task() -> None:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"roadmap_comment": "  заметка  "},
    )
    assert roadmap_comment_from_task(task) == "заметка"

    task.extra_json = {"roadmap_comment": "   "}
    assert roadmap_comment_from_task(task) is None


def test_update_roadmap_comment_sets_value() -> None:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"board_code": "digital_streams_b2b"},
    )
    db = MagicMock()
    db.scalar.return_value = task

    updated = update_roadmap_comment(db, external_id="1115252", comment="локальный комментарий")
    assert updated.extra_json["roadmap_comment"] == "локальный комментарий"
    db.commit.assert_called_once()


def test_update_roadmap_comment_clears_value() -> None:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"roadmap_comment": "старый"},
    )
    db = MagicMock()
    db.scalar.return_value = task

    updated = update_roadmap_comment(db, external_id="1115252", comment=None)
    assert "roadmap_comment" not in (updated.extra_json or {})
