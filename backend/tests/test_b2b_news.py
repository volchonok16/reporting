from __future__ import annotations

import json

from app.b2b_news_db import (
    B2B_NEWS_SECTION_COLUMNS,
    ROW_ID_KEY,
    _cells_json,
    _normalize_cells,
    _row_has_content,
    _section_snapshot_json,
    columns_for_section_gid,
)


def test_news_section_columns() -> None:
    assert B2B_NEWS_SECTION_COLUMNS["news"] == ("Дата", "Новость", "Описание")
    assert B2B_NEWS_SECTION_COLUMNS["launches"] == ("Дата", "Продукт", "Описание")
    assert columns_for_section_gid("news")[0] == "Дата"


def test_normalize_cells_fills_missing_columns() -> None:
    columns = columns_for_section_gid("news")
    cells = _normalize_cells({"Дата": "01.07", "Новость": "SMS Hub"}, columns=columns)
    assert cells["Дата"] == "01.07"
    assert cells["Новость"] == "SMS Hub"
    assert cells["Описание"] == ""
    assert len(cells) == 3


def test_row_has_content() -> None:
    columns = columns_for_section_gid("launches")
    assert _row_has_content(_normalize_cells({"Продукт": "IoT"}, columns=columns))
    assert not _row_has_content(_normalize_cells({}, columns=columns))


def test_cells_json_serializes_for_psycopg() -> None:
    columns = columns_for_section_gid("news")
    payload = _cells_json(_normalize_cells({"Дата": "01.07"}, columns=columns))
    parsed = json.loads(payload)
    assert parsed["Дата"] == "01.07"
    assert isinstance(payload, str)


def test_section_snapshot_json() -> None:
    columns = columns_for_section_gid("news")
    rows = [{"cells": {"Дата": "01.07", "Новость": "X", "Описание": ""}}]
    payload = json.loads(_section_snapshot_json(rows, columns=columns))
    assert payload["rows"][0]["cells"]["Новость"] == "X"


def test_row_id_key_is_private_meta() -> None:
    assert ROW_ID_KEY == "__rowId"
