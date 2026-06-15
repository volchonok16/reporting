from app.product_status_sheets_api import (
    _GRID_DATA_FIELDS,
    _parse_grid_sheet,
    _resolve_sheet_title,
)


def test_parse_grid_sheet_preserves_yellow_text_runs() -> None:
    row_data = [
        {
            "values": [
                {"formattedValue": "Дата запуска"},
                {"formattedValue": "Проект"},
            ]
        },
        {
            "values": [
                {"effectiveValue": {"stringValue": "09.06"}},
                {
                    "effectiveValue": {"stringValue": "Убираем 300 рублевые офферы"},
                    "textFormatRuns": [
                        {"startIndex": 0},
                        {
                            "startIndex": 8,
                            "format": {
                                "backgroundColor": {"red": 1, "green": 1, "blue": 0},
                            },
                        },
                        {"startIndex": 21},
                    ],
                },
            ]
        },
    ]

    columns, rows = _parse_grid_sheet(sheet_name="CORE", row_data=row_data)
    assert columns == ["Дата запуска", "Проект"]
    assert rows[0]["Дата запуска"] == "09.06"
    assert rows[0]["Проект"] == "Убираем $300 рублевые $офферы"


def test_grid_data_fields_mask_includes_text_run_colors() -> None:
    assert "format.backgroundColor" in _GRID_DATA_FIELDS
    assert "format.foregroundColor" in _GRID_DATA_FIELDS


def test_resolve_sheet_title_matches_gid() -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "sheets": [
                    {"properties": {"sheetId": 0, "title": "Продуктовый офис: CORE"}},
                    {"properties": {"sheetId": 1512199647, "title": "Продуктовый офис: SMS"}},
                ]
            }

    class FakeClient:
        def get(self, url: str, params: dict) -> FakeResponse:
            assert params["fields"] == "sheets(properties(sheetId,title))"
            return FakeResponse()

    title = _resolve_sheet_title(
        spreadsheet_id="sheet-id",
        gid="1512199647",
        api_key="test-key",
        client=FakeClient(),  # type: ignore[arg-type]
    )
    assert title == "Продуктовый офис: SMS"


def test_fetch_sheet_with_formatting_skips_title_lookup_when_name_known() -> None:
    grid_calls: list[dict] = []

    class FakeResponse:
        def __init__(self, payload: dict) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return self._payload

    class FakeClient:
        def get(self, url: str, params: dict) -> FakeResponse:
            if params.get("fields") == "sheets(properties(sheetId,title))":
                raise AssertionError("metadata fetch should be skipped when sheet name is known")
            grid_calls.append(params)
            return FakeResponse(
                {
                    "sheets": [
                        {
                            "data": [
                                {
                                    "rowData": [
                                        {
                                            "values": [
                                                {"formattedValue": "Проект"},
                                            ]
                                        },
                                        {
                                            "values": [
                                                {"effectiveValue": {"stringValue": "CORE"}},
                                            ]
                                        },
                                    ]
                                }
                            ]
                        }
                    ]
                }
            )

    from app.product_status_sheets_api import fetch_sheet_with_formatting

    result = fetch_sheet_with_formatting(
        spreadsheet_id="sheet-id",
        sheet_name="Продуктовый офис: CORE",
        gid="0",
        api_key="test-key",
        client=FakeClient(),  # type: ignore[arg-type]
    )
    assert result is not None
    columns, rows = result
    assert columns == ["Проект"]
    assert rows[0]["Проект"] == "CORE"
    assert len(grid_calls) == 1
