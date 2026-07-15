from __future__ import annotations

import json

from app.revenue_activities_db import (
    REVENUE_ACTIVITY_SECTION_COLUMNS,
    ROW_ID_KEY,
    _cells_json,
    _normalize_cells,
    _row_has_content,
    _section_snapshot_json,
    columns_for_section_gid,
)


def test_revenue_section_columns() -> None:
    assert REVENUE_ACTIVITY_SECTION_COLUMNS["main"] == ("Статус", "Ответственный", "Результат")
    assert columns_for_section_gid("main")[0] == "Статус"


def test_normalize_cells_fills_missing_columns() -> None:
    columns = columns_for_section_gid("main")
    cells = _normalize_cells({"Статус": "В работе", "Ответственный": "Иванов"}, columns=columns)
    assert cells["Статус"] == "В работе"
    assert cells["Ответственный"] == "Иванов"
    assert cells["Результат"] == ""
    assert len(cells) == 3


def test_row_has_content() -> None:
    columns = columns_for_section_gid("main")
    assert _row_has_content(_normalize_cells({"Статус": "Готово"}, columns=columns))
    assert not _row_has_content(_normalize_cells({}, columns=columns))


def test_cells_json_serializes_for_psycopg() -> None:
    columns = columns_for_section_gid("main")
    payload = _cells_json(_normalize_cells({"Статус": "В работе"}, columns=columns))
    parsed = json.loads(payload)
    assert parsed["Статус"] == "В работе"
    assert isinstance(payload, str)


def test_section_snapshot_json() -> None:
    columns = columns_for_section_gid("main")
    rows = [{"cells": {"Статус": "В работе", "Ответственный": "X", "Результат": ""}}]
    payload = json.loads(_section_snapshot_json(rows, columns=columns))
    assert payload["rows"][0]["cells"]["Ответственный"] == "X"


def test_row_id_key_is_private_meta() -> None:
    assert ROW_ID_KEY == "__rowId"
