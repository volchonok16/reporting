from app.product_status_rich_text import (
    apply_text_format_runs,
    cell_text_with_highlights,
    display_cell_text,
    is_yellow_highlight_color,
    split_highlight_segments,
)


def test_is_yellow_highlight_color_detects_google_marker() -> None:
    assert is_yellow_highlight_color({"red": 1.0, "green": 1.0, "blue": 0.0})
    assert is_yellow_highlight_color({"red": 1.0, "green": 0.95, "blue": 0.8})
    assert not is_yellow_highlight_color({"red": 1.0, "green": 0.2, "blue": 0.2})


def test_split_highlight_segments() -> None:
    assert split_highlight_segments("Убираем $300 рублевые$ офферы") == [
        ("Убираем ", False),
        ("300 рублевые", True),
        (" офферы", False),
    ]


def test_display_cell_text_strips_markers() -> None:
    assert display_cell_text("$важно$") == "важно"


def test_apply_text_format_runs_wraps_yellow_segments() -> None:
    text = "Убираем 300 рублевые офферы"
    runs = [
        {"startIndex": 0, "format": {}},
        {"startIndex": 8, "format": {"backgroundColor": {"red": 1, "green": 1, "blue": 0}}},
        {"startIndex": 21, "format": {}},
    ]
    assert apply_text_format_runs(text, runs) == "Убираем $300 рублевые $офферы"


def test_cell_text_with_highlights_from_whole_cell_background() -> None:
    cell = {
        "effectiveValue": {"stringValue": "Важная строка"},
        "userEnteredFormat": {"backgroundColor": {"red": 1, "green": 1, "blue": 0}},
    }
    assert cell_text_with_highlights(cell) == "$Важная строка$"
