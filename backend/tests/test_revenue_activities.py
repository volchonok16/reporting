from __future__ import annotations

import json

from app.revenue_activities_db import (
    REVENUE_ACTIVITY_SECTION_COLUMNS,
    REVENUE_NUMERIC_COLUMNS,
    ROW_ID_KEY,
    _cells_json,
    _normalize_cells,
    _parse_numeric,
    _row_has_content,
    _section_snapshot_json,
    columns_for_section_gid,
)


def test_revenue_section_columns() -> None:
    assert REVENUE_ACTIVITY_SECTION_COLUMNS["base"] == (
        "Активность",
        "Статус F2 2026",
        "Ответственный",
        "Влияние на базу, тыс",
        "Влияние на gmc, млн",
        "Комментарий",
    )
    assert REVENUE_ACTIVITY_SECTION_COLUMNS["revenue"] == (
        "Активность",
        "Статус F2 2026",
        "Ответственный",
        "Влияние на выручку, млн",
        "Маржа",
        "Влияние на gmc, млн",
        "Комментарий",
    )
    assert "Влияние на выручку, млн" not in REVENUE_ACTIVITY_SECTION_COLUMNS["base"]
    assert "Влияние на базу, тыс" not in REVENUE_ACTIVITY_SECTION_COLUMNS["revenue"]
    assert "Маржа" not in REVENUE_ACTIVITY_SECTION_COLUMNS["base"]
    assert columns_for_section_gid("base")[0] == "Активность"
    assert "Результат" not in REVENUE_ACTIVITY_SECTION_COLUMNS["base"]
    assert REVENUE_NUMERIC_COLUMNS == (
        "Влияние на базу, тыс",
        "Влияние на выручку, млн",
        "Маржа",
        "Влияние на gmc, млн",
    )


def test_normalize_cells_fills_missing_and_aliases() -> None:
    columns = columns_for_section_gid("base")
    cells = _normalize_cells(
        {
            "Активность": "Акция",
            "Статус": "OK",
            "Влияние на базу": "10",
            "Влияние на выручку": "2,5",
            "Влияние на gmc": "1",
            "Комментарий": "ок",
            "Результат": "13.5",
        },
        columns=columns,
    )
    assert cells["Активность"] == "Акция"
    assert cells["Статус F2 2026"] == "OK"
    assert cells["Влияние на базу, тыс"] == "10"
    assert cells["Влияние на gmc, млн"] == "1"
    assert cells["Комментарий"] == "ок"
    assert "Влияние на выручку, млн" not in cells
    assert "Результат" not in cells
    assert len(cells) == 6


def test_normalize_revenue_section_keeps_revenue_column() -> None:
    columns = columns_for_section_gid("revenue")
    cells = _normalize_cells(
        {
            "Активность": "Акция",
            "Влияние на выручку": "2,5",
            "Влияние на базу": "10",
            "Влияние на gmc": "1",
        },
        columns=columns,
    )
    assert cells["Влияние на выручку, млн"] == "2,5"
    assert "Влияние на базу, тыс" not in cells
    assert cells["Влияние на gmc, млн"] == "1"


def test_normalize_ignores_text_in_numeric_columns() -> None:
    assert _parse_numeric("н/д") is None
    assert _parse_numeric("2,5") == 2.5


def test_row_has_content() -> None:
    columns = columns_for_section_gid("base")
    assert _row_has_content(_normalize_cells({"Активность": "X"}, columns=columns))
    assert not _row_has_content(_normalize_cells({}, columns=columns))


def test_cells_json_serializes_for_psycopg() -> None:
    columns = columns_for_section_gid("base")
    payload = _cells_json(_normalize_cells({"Активность": "Акция"}, columns=columns))
    parsed = json.loads(payload)
    assert parsed["Активность"] == "Акция"
    assert isinstance(payload, str)


def test_section_snapshot_json() -> None:
    columns = columns_for_section_gid("base")
    rows = [
        {
            "cells": {
                "Активность": "Акция",
                "Влияние на базу, тыс": "1",
                "Комментарий": "X",
            }
        }
    ]
    payload = json.loads(_section_snapshot_json(rows, columns=columns))
    assert payload["rows"][0]["cells"]["Комментарий"] == "X"
    assert payload["rows"][0]["cells"]["Влияние на базу, тыс"] == "1"


def test_row_id_key_is_private_meta() -> None:
    assert ROW_ID_KEY == "__rowId"
