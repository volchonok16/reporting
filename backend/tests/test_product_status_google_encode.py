from app.product_status_google_encode import (
    encoded_cell_to_google,
    is_date_column,
    segments_to_text_format_runs,
    sheet_grid_to_google_rows,
)
from app.product_status_rich_text import TextStyleSegment, split_style_segments


def test_is_date_column_matches_launch_date_header() -> None:
    assert is_date_column("Дата запуска")
    assert is_date_column("Дата")
    assert not is_date_column("Проект")


def test_encoded_cell_to_google_date_column_always_uses_string_value() -> None:
    cell = encoded_cell_to_google("09.06", column="Дата запуска")
    assert cell["userEnteredValue"] == {"stringValue": "09.06"}

    cell = encoded_cell_to_google("июль", column="Дата запуска")
    assert cell["userEnteredValue"] == {"stringValue": "июль"}

    cell = encoded_cell_to_google("6", column="Дата запуска")
    assert cell["userEnteredValue"] == {"stringValue": "6"}


def test_sheet_grid_to_google_rows_date_column_uses_string_value() -> None:
    rows = sheet_grid_to_google_rows(
        ["Дата запуска", "Проект"],
        [{"Дата запуска": "09.06", "Проект": "CORE"}],
    )
    assert rows[1]["values"][0]["userEnteredValue"] == {"stringValue": "09.06"}


def test_encoded_cell_to_google_plain_text() -> None:
    cell = encoded_cell_to_google("Простой текст")
    assert cell["userEnteredValue"] == {"stringValue": "Простой текст"}
    assert "textFormatRuns" not in cell


def test_encoded_cell_to_google_with_highlight_and_cell_bg() -> None:
    cell = encoded_cell_to_google("<<cell:bg:C6EFCE>>$важно$<<>>")
    assert cell["userEnteredValue"] == {"stringValue": "важно"}
    assert cell["userEnteredFormat"]["backgroundColor"]["green"] > 0.9
    assert "textFormatRuns" not in cell


def test_encoded_cell_to_google_promotes_full_cell_yellow_marker_to_cell_bg() -> None:
    cell = encoded_cell_to_google("$важно$")
    assert cell["userEnteredValue"] == {"stringValue": "важно"}
    assert cell["userEnteredFormat"]["backgroundColor"]["red"] == 1.0
    assert cell["userEnteredFormat"]["backgroundColor"]["green"] == 1.0
    assert "textFormatRuns" not in cell


def test_encoded_cell_to_google_partial_yellow_does_not_use_run_background() -> None:
    cell = encoded_cell_to_google("Убираем $300 рублевые$ офферы")
    assert cell["userEnteredValue"] == {"stringValue": "Убираем 300 рублевые офферы"}
    assert "userEnteredFormat" not in cell
    for run in cell.get("textFormatRuns") or []:
        assert "backgroundColor" not in run.get("format", {})


def test_segments_to_text_format_runs_mixed_plain_and_colored() -> None:
    segments = split_style_segments("Убираем $300 рублевые$ офферы")
    runs = segments_to_text_format_runs(segments)
    assert runs is None


def test_sheet_grid_to_google_rows_includes_header() -> None:
    rows = sheet_grid_to_google_rows(
        ["Дата", "Проект"],
        [{"Дата": "09.06", "Проект": "[[fg:FF0000::CORE]]"}],
    )
    assert len(rows) == 2
    assert rows[0]["values"][0]["userEnteredValue"] == {"stringValue": "Дата"}
    assert rows[1]["values"][1]["userEnteredValue"] == {"stringValue": "CORE"}
    assert rows[1]["values"][1]["textFormatRuns"][0]["format"]["foregroundColor"]["red"] == 1.0


def test_encoded_cell_to_google_zni_column_uses_number_value() -> None:
    cell = encoded_cell_to_google("441181", column="ЗНИ")
    assert cell["userEnteredValue"] == {"numberValue": 441181}
    assert "textFormatRuns" not in cell


def test_encoded_cell_to_google_zni_column_normalizes_trailing_zeroes() -> None:
    cell = encoded_cell_to_google("1097564.0", column="ЗНИ")
    assert cell["userEnteredValue"] == {"numberValue": 1097564}


def test_encoded_cell_to_google_plain_integer_without_column_uses_number_value() -> None:
    cell = encoded_cell_to_google("1200320")
    assert cell["userEnteredValue"] == {"numberValue": 1200320}


def test_encoded_cell_to_google_styled_integer_stays_string() -> None:
    cell = encoded_cell_to_google("[[fg:FF0000::300]]")
    assert cell["userEnteredValue"] == {"stringValue": "300"}


def test_sheet_grid_to_google_rows_zni_column_uses_number_value() -> None:
    rows = sheet_grid_to_google_rows(
        ["ЗНИ", "Проект"],
        [{"ЗНИ": "441181", "Проект": "CORE"}],
    )
    assert rows[1]["values"][0]["userEnteredValue"] == {"numberValue": 441181}
    assert rows[1]["values"][1]["userEnteredValue"] == {"stringValue": "CORE"}
