from __future__ import annotations

import json
from unittest.mock import MagicMock

from app.b2b_product_status_db import (
    ADMIN_ONLY_COLUMNS,
    B2B_PRODUCT_STATUS_COLUMNS,
    ROW_ID_KEY,
    _office_snapshot_json,
    _normalize_cells,
    _cells_json,
    _row_has_content,
    save_b2b_product_status_to_db,
)
from app.schemas import (
    ProductStatusCellUpdate,
    ProductStatusSaveIn,
)


def test_columns_include_coordination_and_flags() -> None:
    assert "Проект координация" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Зачем и для чего делаем" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Зачем и для чего делаем полное описание" not in B2B_PRODUCT_STATUS_COLUMNS
    assert "Зачем и для чего делаем для презентации" not in B2B_PRODUCT_STATUS_COLUMNS
    assert "Идет в презентацию" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Обратить внимание" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Комментарий" in B2B_PRODUCT_STATUS_COLUMNS
    assert "ЗНИ" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Проект координация" not in ADMIN_ONLY_COLUMNS


def test_normalize_cells_fills_missing_columns() -> None:
    cells = _normalize_cells(
        {"Дата запуска": "01.07", "ЗНИ": "123456, 789012"}
    )
    assert cells["Дата запуска"] == "01.07"
    assert cells["ЗНИ"] == "123456, 789012"
    assert cells["Проект координация"] == ""
    assert len(cells) == len(B2B_PRODUCT_STATUS_COLUMNS)


def test_normalize_cells_merges_legacy_why_columns() -> None:
    cells = _normalize_cells(
        {
            "Зачем и для чего делаем полное описание": "Полный зачем",
            "Зачем и для чего делаем для презентации": "Короткий зачем",
        }
    )
    assert cells["Зачем и для чего делаем"] == "Короткий зачем"

    cells = _normalize_cells(
        {
            "Зачем и для чего делаем": "Текущий зачем",
            "Зачем и для чего делаем для презентации": "Короткий зачем",
        }
    )
    assert cells["Зачем и для чего делаем"] == "Текущий зачем"

    cells = _normalize_cells(
        {
            "Зачем и для чего делаем полное описание": "Полный зачем",
        }
    )
    assert cells["Зачем и для чего делаем"] == "Полный зачем"


def test_row_has_content() -> None:
    assert _row_has_content(
        _normalize_cells({"Дата запуска": "01.07"})
    )
    assert not _row_has_content(_normalize_cells({}))


def test_cells_json_serializes_for_psycopg() -> None:
    payload = _cells_json(
        _normalize_cells({"Дата запуска": "01.07", "ЗНИ": "123456"})
    )
    parsed = json.loads(payload)
    assert parsed["Дата запуска"] == "01.07"
    assert parsed["ЗНИ"] == "123456"
    assert isinstance(payload, str)


def test_save_without_row_id_creates_new_row_instead_of_overwriting() -> None:
    """Empty prepended rows used to clear the table via 1-based index overwrite."""
    office_result = MagicMock()
    office_result.first.return_value = MagicMock(
        _mapping={"id": 1, "gid": "0", "name": "Офис: CORE"}
    )

    existing_cells = {
        "Дата запуска": "01.07",
        "Проект координация": "keep-me",
    }
    row_result = MagicMock()
    row_result.__iter__.return_value = iter(
        [
            MagicMock(
                _mapping={
                    "id": 10,
                    "cells": existing_cells,
                    "sort_order": 0,
                }
            )
        ]
    )

    insert_result = MagicMock()
    insert_result.first.return_value = MagicMock(
        _mapping={"id": 99, "cells": {}, "sort_order": 1}
    )

    snapshot_rows_result = MagicMock()
    snapshot_rows_result.__iter__.return_value = iter(
        [
            MagicMock(
                _mapping={
                    "id": 10,
                    "cells": existing_cells,
                    "sort_order": 0,
                }
            ),
            MagicMock(
                _mapping={
                    "id": 99,
                    "cells": {"Дата запуска": "new"},
                    "sort_order": 1,
                }
            ),
        ]
    )

    db = MagicMock()
    db.execute.side_effect = [
        office_result,
        row_result,
        insert_result,  # create new row
        MagicMock(),  # history create
        MagicMock(),  # update cells on new row
        MagicMock(),  # history update
        MagicMock(),  # reorder/sort updates (may vary)
        MagicMock(),
        snapshot_rows_result,
        MagicMock(),
    ]

    save_b2b_product_status_to_db(
        db,
        ProductStatusSaveIn(
            updates=[
                ProductStatusCellUpdate(
                    gid="0",
                    rowIndex=1,
                    columnIndex=0,
                    column="Дата запуска",
                    value="new",
                    expectedValue="",
                    rowId=None,
                ),
            ]
        ),
        meta={
            "auth_mode": "app_user",
            "app_role": "full",
            "org_user_role": "user",
        },
    )

    insert_sql = str(db.execute.call_args_list[2].args[0])
    assert "INSERT INTO b2b_product_status_row" in insert_sql
    # Existing row must not be updated by this save (no UPDATE targeting id=10).
    update_calls = [
        call
        for call in db.execute.call_args_list
        if "UPDATE b2b_product_status_row" in str(call.args[0])
        and "SET cells" in str(call.args[0])
    ]
    assert len(update_calls) == 1
    assert update_calls[0].kwargs.get("row_id") == 99 or (
        update_calls[0].args[1].get("row_id") == 99
    )
    db.commit.assert_called_once()


def test_save_allows_coordination_column_for_non_admin() -> None:
    office_result = MagicMock()
    office_result.first.return_value = MagicMock(
        _mapping={"id": 1, "gid": "0", "name": "Офис: CORE"}
    )

    row_result = MagicMock()
    row_result.__iter__.return_value = iter(
        [
            MagicMock(
                _mapping={
                    "id": 10,
                    "cells": {"Проект координация": "", "Дата запуска": ""},
                    "sort_order": 0,
                }
            )
        ]
    )

    snapshot_rows_result = MagicMock()
    snapshot_rows_result.__iter__.return_value = iter(
        [
            MagicMock(
                _mapping={
                    "id": 10,
                    "cells": {"Проект координация": "secret", "Дата запуска": ""},
                    "sort_order": 0,
                }
            )
        ]
    )

    db = MagicMock()
    update_result = MagicMock()
    update_result.rowcount = 1
    db.execute.side_effect = [
        office_result,
        row_result,
        update_result,
        MagicMock(),
        MagicMock(),
        snapshot_rows_result,
        MagicMock(),
    ]

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
                    expectedValue="",
                    rowId=10,
                ),
            ]
        ),
        meta={
            "auth_mode": "app_user",
            "app_role": "full",
            "org_user_role": "user",
        },
    )

    db.commit.assert_called_once()


def test_row_id_key_is_private_meta() -> None:
    assert ROW_ID_KEY == "__rowId"


def test_office_snapshot_json_roundtrip() -> None:
    rows = [
        {"cells": {"Дата запуска": "01.07", "ЗНИ": "123"}},
        {"cells": {"Дата запуска": ""}},
    ]
    payload = json.loads(_office_snapshot_json(rows))
    assert len(payload["rows"]) == 2
    assert payload["rows"][0]["cells"]["Дата запуска"] == "01.07"
    assert payload["rows"][1]["cells"]["Проект координация"] == ""
