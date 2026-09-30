from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.b2b_product_status_db import (
    ADMIN_ONLY_COLUMNS,
    B2B_PRODUCT_STATUS_COLUMNS,
    ROW_ID_KEY,
    SUMMARY_GID,
    SUMMARY_OFFICE_COLUMN,
    SUMMARY_PROJECT_TITLE_KEY,
    SUMMARY_STATUS_COLUMN,
    WHY_COLUMN,
    _office_snapshot_json,
    _normalize_cells,
    _cells_json,
    _office_summary_label,
    _row_has_content,
    build_summary_rows,
    save_b2b_product_status_to_db,
    set_b2b_product_status_office_editing_locked,
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
    assert "Приоритет" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Неактуальное" in B2B_PRODUCT_STATUS_COLUMNS
    assert "ЗНИ" in B2B_PRODUCT_STATUS_COLUMNS
    assert "Проект координация" not in ADMIN_ONLY_COLUMNS


def test_office_summary_label_strips_prefix() -> None:
    assert _office_summary_label("Офис: SMS") == "SMS"
    assert _office_summary_label("Аналитики: планирование") == "Аналитики: планирование"


def test_build_summary_rows_only_presentation_and_office_order() -> None:
    offices = [
        {"gid": "voice", "name": "Офис: VOICE"},
        {"gid": "sms", "name": "Офис: SMS"},
    ]
    voice_rows = [
        {
            "id": 1,
            "cells": {
                "Проект координация": "Voice A",
                "Для презентации Описание проекта и статус": "Статус A",
                "Зачем и для чего делаем": "Зачем A",
                "Идет в презентацию": "Нет",
            },
        },
        {
            "id": 2,
            "cells": {
                "Проект координация": "Voice B",
                "Для презентации Описание проекта и статус": "Статус B",
                "Зачем и для чего делаем": "Зачем B",
                "Идет в презентацию": "Да",
            },
        },
    ]
    sms_rows = [
        {
            "id": 3,
            "cells": {
                "Проект координация": "SMS C",
                "Для презентации Описание проекта и статус": "Статус C",
                "Зачем и для чего делаем": "Зачем C",
                "Идет в презентацию": "да",
            },
        },
    ]
    rows = build_summary_rows(
        [
            (offices[0], voice_rows),
            (offices[1], sms_rows),
        ]
    )
    assert [row[SUMMARY_OFFICE_COLUMN] for row in rows] == ["VOICE", "SMS"]
    assert [row[SUMMARY_PROJECT_TITLE_KEY] for row in rows] == ["Voice B", "SMS C"]
    assert [row[SUMMARY_STATUS_COLUMN] for row in rows] == ["Статус B", "Статус C"]
    assert "Название проекта" not in rows[0]
    assert [row[WHY_COLUMN] for row in rows] == ["Зачем B", "Зачем C"]
    assert rows[0][ROW_ID_KEY].startswith(f"{SUMMARY_GID}-voice-")


def test_build_summary_rows_keeps_embedded_table_token() -> None:
    import base64

    payload = {
        "text": "Сверху",
        "afterText": "",
        "table": {
            "rows": 1,
            "cols": 2,
            "cells": [["Q1", "Q2"]],
        },
    }
    token = (
        "<<tablejson:"
        + base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
        + ">>"
    )
    rows = build_summary_rows(
        [
            (
                {"gid": "voice", "name": "Офис: VOICE"},
                [
                    {
                        "id": 1,
                        "cells": {
                            "Проект координация": "Voice T",
                            "Для презентации Описание проекта и статус": token,
                            "Зачем и для чего делаем": "Зачем",
                            "Идет в презентацию": "Да",
                        },
                    }
                ],
            )
        ]
    )
    assert rows[0][SUMMARY_STATUS_COLUMN] == token
    assert rows[0][SUMMARY_PROJECT_TITLE_KEY] == "Voice T"


def test_build_summary_rows_takes_table_from_full_status_when_presentation_plain() -> None:
    import base64

    payload = {
        "text": "",
        "afterText": "",
        "table": {
            "rows": 1,
            "cols": 1,
            "cells": [["Из полного"]],
        },
    }
    token = (
        "<<tablejson:"
        + base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
        + ">>"
    )
    rows = build_summary_rows(
        [
            (
                {"gid": "voice", "name": "Офис: VOICE"},
                [
                    {
                        "id": 1,
                        "cells": {
                            "Проект координация": "Voice T",
                            "Полное Описание проекта и статус": token,
                            "Для презентации Описание проекта и статус": "Короткий статус",
                            "Зачем и для чего делаем": "Зачем",
                            "Идет в презентацию": "Да",
                        },
                    }
                ],
            )
        ]
    )
    assert rows[0][SUMMARY_STATUS_COLUMN] == token


def test_normalize_cells_fills_missing_columns() -> None:
    cells = _normalize_cells(
        {"Дата запуска": "01.07", "ЗНИ": "123456, 789012"}
    )
    assert cells["Дата запуска"] == "01.07"
    assert cells["ЗНИ"] == "123456, 789012"
    assert cells["Проект координация"] == ""
    assert cells["Приоритет"] == ""
    assert cells["Неактуальное"] == ""
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


def test_save_rejects_when_office_editing_locked() -> None:
    office_result = MagicMock()
    office_result.first.return_value = MagicMock(
        _mapping={
            "id": 1,
            "gid": "0",
            "name": "Офис: CORE",
            "editing_locked": True,
        }
    )
    db = MagicMock()
    db.execute.side_effect = [office_result]

    with pytest.raises(HTTPException) as exc_info:
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
                        rowId=10,
                    ),
                ]
            ),
            meta={
                "auth_mode": "app_user",
                "app_role": "full",
                "org_user_role": "admin",
            },
        )

    assert exc_info.value.status_code == 403
    assert "заблокировано" in exc_info.value.detail.lower()
    db.commit.assert_not_called()


def test_set_office_editing_locked_updates_flag() -> None:
    office_result = MagicMock()
    office_result.first.return_value = MagicMock(
        _mapping={
            "id": 7,
            "gid": "1512199647",
            "name": "Офис: SMS",
            "editing_locked": False,
        }
    )
    projects_result = MagicMock()
    projects_result.__iter__.return_value = iter([])
    rows_result = MagicMock()
    rows_result.__iter__.return_value = iter([])

    db = MagicMock()
    db.execute.side_effect = [
        office_result,
        MagicMock(),
        projects_result,
        rows_result,
    ]

    sheet = set_b2b_product_status_office_editing_locked(
        db,
        gid="1512199647",
        locked=True,
    )

    assert sheet.editingLocked is True
    assert sheet.gid == "1512199647"
    update_sql = str(db.execute.call_args_list[1].args[0])
    assert "UPDATE b2b_product_status_office" in update_sql
    db.commit.assert_called_once()
