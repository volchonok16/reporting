from app.product_status_sheets_api import _parse_grid_sheet


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
