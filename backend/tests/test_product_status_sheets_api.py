import httpx

from app.product_status_sheets_api import (
    _GRID_DATA_FIELDS,
    _parse_grid_sheet,
    _quote_sheet_range,
    _resolve_sheet_title,
    _sheet_titles_for_fetch,
)


def test_quote_sheet_range_escapes_special_chars() -> None:
    assert _quote_sheet_range("Офис: M2M / IoT") == "'Офис: M2M / IoT'"
    assert _quote_sheet_range("It's fine") == "'It\\'s fine'"


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


def test_fetch_sheet_with_formatting_prefers_title_from_gid() -> None:
    grid_calls: list[str] = []

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
                return FakeResponse(
                    {
                        "sheets": [
                            {
                                "properties": {
                                    "sheetId": 102191664,
                                    "title": "Продуктовый офис: M2M / IoT",
                                }
                            }
                        ]
                    }
                )
            grid_calls.append(params["ranges"])
            if "'Офис: M2M / IoT'" in params["ranges"]:
                raise httpx.HTTPStatusError(
                    "bad range",
                    request=httpx.Request("GET", url),
                    response=httpx.Response(400, request=httpx.Request("GET", url)),
                )
            return FakeResponse(
                {
                    "sheets": [
                        {
                            "data": [
                                {
                                    "rowData": [
                                        {"values": [{"formattedValue": "Проект"}]},
                                        {"values": [{"effectiveValue": {"stringValue": "M2M"}}]},
                                    ]
                                }
                            ]
                        }
                    ]
                }
            )

    from app.product_status_sheets_api import fetch_sheet_with_formatting

    result = fetch_sheet_with_formatting(
        spreadsheet_id="sheet-id-m2m",
        sheet_name="Офис: M2M / IoT",
        gid="102191664",
        api_key="test-key",
        client=FakeClient(),  # type: ignore[arg-type]
    )
    assert result is not None
    columns, rows = result
    assert columns == ["Проект"]
    assert rows[0]["Проект"] == "M2M"
    assert grid_calls[0].startswith("'Продуктовый офис: M2M / IoT'!")
    assert len(grid_calls) == 1


def test_sheet_titles_for_fetch_prefers_metadata_title() -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "sheets": [
                    {
                        "properties": {
                            "sheetId": 102191664,
                            "title": "Продуктовый офис: M2M / IoT",
                        }
                    }
                ]
            }

    class FakeClient:
        def get(self, url: str, params: dict) -> FakeResponse:
            return FakeResponse()

    titles = _sheet_titles_for_fetch(
        spreadsheet_id="sheet-id-m2m",
        sheet_name="Офис: M2M / IoT",
        gid="102191664",
        api_key="test-key",
        client=FakeClient(),  # type: ignore[arg-type]
    )
    assert titles == ["Продуктовый офис: M2M / IoT", "Офис: M2M / IoT"]
