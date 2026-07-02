from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.b2b_product_status_db import (
    ADMIN_ONLY_COLUMNS,
    B2B_PRODUCT_STATUS_COLUMNS,
    ROW_ID_KEY,
    _normalize_cells,
    _row_has_content,
    save_b2b_product_status_to_db,
)
from app.schemas import ProductStatusCellUpdate, ProductStatusSaveIn


def test_columns_include_coordination_and_flags() -> None:
    assert "Проект координация" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Идет в презентацию" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Обратить внимание" in B2B_PRODUCT_STATUS_COLUMNS
    assert "ЗНИ" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Проект координация" in ADMIN_ONLY_COLUMNS


def test_normalize_cells_fills_missing_columns() -> None:
    cells = _normalize_cells({"Дата запуска": "01.07", "ЗНИ": "123456, 789012"})
    assert cells["Дата запуска"] == "01.07"
    assert cells["ЗНИ"] == "123456, 789012"
    assert cells["Проект координация"] == ""
    assert len(cells) == len(B2B_PRODUCT_STATUS_COLUMNS)


def test_row_has_content() -> None:
    assert _row_has_content(_normalize_cells({"Дата запуска": "01.07"}))
    assert not _row_has_content(_normalize_cells({}))


def test_save_rejects_admin_column_for_non_admin() -> None:
    db = MagicMock()
    db.execute.side_effect = [
        MagicMock(first=lambda: MagicMock(_mapping={"id": 1, "gid": "0", "name": "Офис: CORE"})),
        MagicMock(__iter__=lambda self: iter([])),
    ]
    with pytest.raises(HTTPException) as exc:
        save_b2b_product_status_to_db(
            db,
            ProductStatusSaveIn(
                updates=[
                    ProductStatusCellUpdate(
                        gid="0",
                        rowIndex=1,
                        columnIndex=1,
                        column="Проект координация",
                        value="secret",
                    ),
                ]
            ),
            meta={"auth_mode": "app_user", "app_role": "full", "org_user_role": "user"},
        )
    assert exc.value.status_code == 403


def test_row_id_key_is_private_meta() -> None:
    assert ROW_ID_KEY == "__rowId"
