from app.product_status_rich_text import (
    HighlightSegment,
    apply_text_format_runs,
    cell_highlight_colors,
    cell_text_with_highlights,
    color_to_hex,
    display_cell_text,
    encode_highlight,
    is_yellow_highlight_color,
    split_highlight_segments,
)


def test_color_to_hex_from_google_rgb() -> None:
    assert color_to_hex({"red": 1.0, "green": 1.0, "blue": 0.0}) == "FFFF00"
    assert color_to_hex({"red": 1.0, "green": 0.4, "blue": 0.7}) == "FF66B2"
    assert color_to_hex({"red": 1.0, "green": 1.0, "blue": 1.0}) is None


def test_is_yellow_highlight_color_detects_google_marker() -> None:
    assert is_yellow_highlight_color({"red": 1.0, "green": 1.0, "blue": 0.0})
    assert is_yellow_highlight_color({"red": 1.0, "green": 0.95, "blue": 0.8})
    assert not is_yellow_highlight_color({"red": 1.0, "green": 0.2, "blue": 0.2})


def test_split_highlight_segments_legacy_yellow() -> None:
    assert split_highlight_segments("Убираем $300 рублевые$ офферы") == [
        HighlightSegment(text="Убираем ", color=None),
        HighlightSegment(text="300 рублевые", color="FFFF00"),
        HighlightSegment(text=" офферы", color=None),
    ]


def test_split_highlight_segments_colored_markers() -> None:
    assert split_highlight_segments("строка {{FF66B2:розовый}} текст") == [
        HighlightSegment(text="строка ", color=None),
        HighlightSegment(text="розовый", color="FF66B2"),
        HighlightSegment(text=" текст", color=None),
    ]


def test_encode_highlight_uses_legacy_marker_for_yellow() -> None:
    assert encode_highlight("важно", "FFFF00") == "$важно$"
    assert encode_highlight("важно", "FF66B2") == "{{FF66B2:важно}}"


def test_display_cell_text_strips_markers() -> None:
    assert display_cell_text("$важно$") == "важно"
    assert display_cell_text("{{00B050:зелёный}}") == "зелёный"


def test_apply_text_format_runs_wraps_colored_segments() -> None:
    text = "Убираем 300 рублевые офферы"
    runs = [
        {"startIndex": 0, "format": {}},
        {"startIndex": 8, "format": {"backgroundColor": {"red": 1, "green": 1, "blue": 0}}},
        {"startIndex": 21, "format": {}},
    ]
    assert apply_text_format_runs(text, runs) == "Убираем $300 рублевые $офферы"

    pink_runs = [
        {"startIndex": 0, "format": {}},
        {"startIndex": 6, "format": {"backgroundColor": {"red": 1, "green": 0.4, "blue": 0.7}}},
        {"startIndex": 13, "format": {}},
    ]
    assert apply_text_format_runs("текст розовый хвост", pink_runs) == "текст {{FF66B2:розовый}} хвост"


def test_cell_text_with_highlights_from_whole_cell_background() -> None:
    cell = {
        "effectiveValue": {"stringValue": "Важная строка"},
        "userEnteredFormat": {"backgroundColor": {"red": 0, "green": 0.69, "blue": 0.31}},
    }
    assert cell_text_with_highlights(cell) == encode_highlight(
        "Важная строка",
        color_to_hex(cell["userEnteredFormat"]["backgroundColor"]) or "",
    )


def test_cell_highlight_colors_collects_unique_order() -> None:
    assert cell_highlight_colors("$жёлтый$ и {{FF66B2:розовый}}") == ["FFFF00", "FF66B2"]
