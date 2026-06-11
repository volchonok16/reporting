from app.product_status_google_encode import (
    encoded_cell_to_google,
    segments_to_text_format_runs,
    sheet_grid_to_google_rows,
)
from app.product_status_rich_text import TextStyleSegment, split_style_segments


def test_encoded_cell_to_google_plain_text() -> None:
    cell = encoded_cell_to_google("Простой текст")
    assert cell["userEnteredValue"] == {"stringValue": "Простой текст"}
    assert "textFormatRuns" not in cell


def test_encoded_cell_to_google_with_highlight_and_cell_bg() -> None:
    cell = encoded_cell_to_google("<<cell:bg:C6EFCE>>$важно$<<>>")
    assert cell["userEnteredValue"] == {"stringValue": "важно"}
    assert cell["userEnteredFormat"]["backgroundColor"]["green"] > 0.9
    runs = cell["textFormatRuns"]
    assert runs[0]["startIndex"] == 0
    assert runs[0]["format"]["backgroundColor"]["blue"] == 0.0


def test_segments_to_text_format_runs_mixed_plain_and_colored() -> None:
    segments = split_style_segments("Убираем $300 рублевые$ офферы")
    runs = segments_to_text_format_runs(segments)
    assert runs is not None
    assert runs[0] == {"startIndex": 0, "format": {}}
    assert runs[1]["startIndex"] == 8
    assert runs[1]["format"]["backgroundColor"]["red"] == 1.0


def test_sheet_grid_to_google_rows_includes_header() -> None:
    rows = sheet_grid_to_google_rows(
        ["Дата", "Проект"],
        [{"Дата": "09.06", "Проект": "[[fg:FF0000::CORE]]"}],
    )
    assert len(rows) == 2
    assert rows[0]["values"][0]["userEnteredValue"] == {"stringValue": "Дата"}
    assert rows[1]["values"][1]["userEnteredValue"] == {"stringValue": "CORE"}
    assert rows[1]["values"][1]["textFormatRuns"][0]["format"]["foregroundColor"]["red"] == 1.0
