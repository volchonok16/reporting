from unittest.mock import MagicMock

from app.models import Task
from app.report_service import load_change_requests_by_numbers


def _zni(**kwargs) -> Task:
    defaults = {
        "id": 1,
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "441181",
        "title": "SMS Hub",
        "task_type": "change_request",
        "source_team": "Digital Streams B2b",
        "extra_json": {
            "board_code": "digital_streams_b2b",
            "customer_name": "Иванов Иван",
            "business_goal": "Увеличить продажи",
        },
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_load_change_requests_by_numbers_returns_matches_in_request_order() -> None:
    db = MagicMock()
    db.scalars.side_effect = [
        [_zni(external_id="441181"), _zni(id=2, external_id="999999")],
        [],
    ]

    items = load_change_requests_by_numbers(db, ["999999", "441181", "441181", "abc"])

    assert [item.number for item in items] == ["999999", "441181"]
    assert items[0].title == "SMS Hub"
    assert items[1].customerName == "Иванов Иван"


def test_load_change_requests_by_numbers_skips_unknown() -> None:
    db = MagicMock()
    db.scalars.side_effect = [[], []]

    assert load_change_requests_by_numbers(db, ["1234567"]) == []
    assert load_change_requests_by_numbers(db, []) == []
