from __future__ import annotations

import json

from app.revenue_activities_db import (
    REVENUE_ACTIVITY_SECTION_COLUMNS,
    REVENUE_NUMERIC_COLUMNS,
    REVENUE_SUM_COLUMN,
    ROW_ID_KEY,
    _cells_json,
    _normalize_cells,
    _parse_numeric,
    _row_has_content,
    _section_snapshot_json,
    columns_for_section_gid,
)


def test_revenue_section_columns() -> None:
    assert REVENUE_ACTIVITY_SECTION_COLUMNS["main"] == (
        "Активность",
        "Влияние на базу",
        "Влияние на выручку",
        "Влияние на gmc",
        "Комментарий",
        "Результат",
    )
    assert columns_for_section_gid("main")[0] == "Активность"
    assert REVENUE_SUM_COLUMN == "Результат"
    assert REVENUE_NUMERIC_COLUMNS == (
        "Влияние на базу",
        "Влияние на выручку",
        "Влияние на gmc",
    )


def test_normalize_cells_fills_missing_and_sums() -> None:
    columns = columns_for_section_gid("main")
    cells = _normalize_cells(
        {
            "Активность": "Акция",
            "Влияние на базу": "10",
            "Влияние на выручку": "2,5",
            "Влияние на gmc": "1",
            "Комментарий": "ок",
        },
        columns=columns,
    )
    assert cells["Активность"] == "Акция"
    assert cells["Комментарий"] == "ок"
    assert cells["Результат"] == "13.5"
    assert len(cells) == 6


def test_normalize_ignores_text_in_numeric_columns() -> None:
    columns = columns_for_section_gid("main")
    cells = _normalize_cells(
        {
            "Влияние на базу": "10",
            "Влияние на выручку": "н/д",
            "Влияние на gmc": "5",
        },
        columns=columns,
    )
    assert cells["Результат"] == "15"
    assert _parse_numeric("н/д") is None


def test_row_has_content_ignores_sum_only() -> None:
    columns = columns_for_section_gid("main")
    assert _row_has_content(_normalize_cells({"Активность": "X"}, columns=columns))
    assert not _row_has_content(_normalize_cells({}, columns=columns))


def test_cells_json_serializes_for_psycopg() -> None:
    columns = columns_for_section_gid("main")
    payload = _cells_json(_normalize_cells({"Активность": "Акция"}, columns=columns))
    parsed = json.loads(payload)
    assert parsed["Активность"] == "Акция"
    assert isinstance(payload, str)


def test_section_snapshot_json() -> None:
    columns = columns_for_section_gid("main")
    rows = [
        {
            "cells": {
                "Активность": "Акция",
                "Влияние на базу": "1",
                "Комментарий": "X",
            }
        }
    ]
    payload = json.loads(_section_snapshot_json(rows, columns=columns))
    assert payload["rows"][0]["cells"]["Комментарий"] == "X"
    assert payload["rows"][0]["cells"]["Результат"] == "1"


def test_row_id_key_is_private_meta() -> None:
    assert ROW_ID_KEY == "__rowId"
