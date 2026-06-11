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


def test_grid_data_fields_mask_excludes_unreadable_text_run_background() -> None:
    assert "textFormatRuns(format.backgroundColor" not in _GRID_DATA_FIELDS
    assert "textFormatRuns(format.foregroundColor" in _GRID_DATA_FIELDS


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
