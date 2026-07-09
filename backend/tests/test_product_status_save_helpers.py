from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.product_status_save_helpers import (
    raise_save_conflicts,
    resolve_row,
    update_row_cell_if_expected,
)
from app.schemas import ProductStatusCellUpdate


def test_resolve_row_prefers_row_id() -> None:
    db_rows = [{"id": 1}, {"id": 2}]
    row_by_id = {1: db_rows[0], 2: db_rows[1]}
    update = ProductStatusCellUpdate(
        gid="0",
        rowIndex=1,
        columnIndex=0,
        value="next",
        rowId=2,
    )
    assert resolve_row(update, db_rows=db_rows, row_by_id=row_by_id) == db_rows[1]


def test_update_row_cell_if_expected_returns_false_when_value_changed() -> None:
    db = MagicMock()
    db.execute.return_value.rowcount = 0

    updated = update_row_cell_if_expected(
        db,
        table="b2b_product_status_row",
        parent_column="office_id",
        parent_id=1,
        row_id=10,
        column="ЗНИ",
        expected_value="111",
        new_value="222",
    )

    assert updated is False


def test_raise_save_conflicts_uses_409() -> None:
    with pytest.raises(HTTPException) as exc:
        raise_save_conflicts(["ЗНИ (строка 2)"])
    assert exc.value.status_code == 409
    assert "другим пользователем" in str(exc.value.detail)
