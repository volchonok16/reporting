from unittest.mock import MagicMock

from app.models import Task
from app.product_service import load_products


def _product(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "100",
        "title": "Продукт A",
        "task_type": "product",
        "source_status": "Active",
        "extra_json": {"assigned_to": "Иванов"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def _zni(**kwargs) -> Task:
    defaults = {
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "441181",
        "title": "ЗНИ A",
        "task_type": "change_request",
        "source_status": "UAT",
        "source_team": "Digital Streams B2b",
        "extra_json": {"board_code": "digital_streams_b2b"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_load_products_hides_closed_zni_when_requested() -> None:
    product = _product()
    product.id = 1
    open_zni = _zni(parent_task_id=1, external_id="441181")
    open_zni.id = 10
    closed_zni = _zni(parent_task_id=1, external_id="441182", source_status="Closed")
    closed_zni.id = 11

    db = MagicMock()
    db.scalars.side_effect = [
        [product],
        [open_zni, closed_zni],
    ]

    hidden = load_products(db, hide_closed=True)
    assert hidden.totalShown == 1
    assert hidden.items[0].zniCount == 1
    assert hidden.items[0].zniItems[0].number == "441181"

    db.scalars.side_effect = [
        [product],
        [open_zni, closed_zni],
    ]
    shown = load_products(db, hide_closed=False)
    assert shown.items[0].zniCount == 2
