from app.linked_environments import _linked_record
from app.report_service import _linked_environments
from app.models import Task
from app.zni_linked_environments import (
    DIGITAL_LINKED_ENVIRONMENT_TARGETS,
    LinkedEnvironmentTarget,
    linked_environment_records_from_extra,
)


def test_digital_linked_environment_targets() -> None:
    keys = {target.key for target in DIGITAL_LINKED_ENVIRONMENT_TARGETS}
    assert keys == {"crm", "bercut"}


def test_linked_record_shape() -> None:
    target = LinkedEnvironmentTarget(key="bercut", label="Bercut", board_code="be_t2_team")
    record = _linked_record(
        target,
        linked_id=625364,
        fields={"System.State": "Closed", "System.BoardColumn": "Closed"},
        url="https://example/625364",
    )
    assert record["key"] == "bercut"
    assert record["zni_id"] == "625364"
    assert record["status"] == "Closed"


def test_linked_environment_records_from_extra_filters_invalid() -> None:
    extra = {
        "linked_environments": [
            {"key": "crm", "zni_id": "1216977", "status": "New"},
            {"key": "", "zni_id": "1"},
            "bad",
        ]
    }
    records = linked_environment_records_from_extra(extra)
    assert len(records) == 1
    assert records[0]["zni_id"] == "1216977"


def test_report_service_linked_environments() -> None:
    task = Task(
        extra_json={
            "linked_environments": [
                {
                    "key": "crm",
                    "label": "CRM",
                    "zni_id": "1216977",
                    "status": "New",
                    "board_column": "New",
                    "url": "https://example/1216977",
                }
            ]
        }
    )
    items = _linked_environments(task)
    assert len(items) == 1
    assert items[0].key == "crm"
    assert items[0].zniId == "1216977"
    assert items[0].status == "New"
