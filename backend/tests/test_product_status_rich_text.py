from app.product_status_rich_text import (
    TextStyleSegment,
    apply_text_format_runs,
    cell_highlight_colors,
    cell_text_with_highlights,
    color_to_hex,
    display_cell_text,
    encode_style_segment,
    is_yellow_highlight_color,
    split_cell_wrapper,
    split_highlight_segments,
    split_style_segments,
)


def test_color_to_hex_from_google_rgb() -> None:
    assert color_to_hex({"red": 1.0, "green": 1.0, "blue": 0.0}) == "FFFF00"
    assert color_to_hex({"red": 1.0, "green": 0.4, "blue": 0.7}) == "FF66B2"
    assert color_to_hex({"red": 1.0, "green": 1.0, "blue": 1.0}) is None


def test_is_yellow_highlight_color_detects_google_marker() -> None:
    assert is_yellow_highlight_color({"red": 1.0, "green": 1.0, "blue": 0.0})
    assert is_yellow_highlight_color({"red": 1.0, "green": 0.95, "blue": 0.8})
    assert not is_yellow_highlight_color({"red": 1.0, "green": 0.2, "blue": 0.2})


def test_split_style_segments_legacy_and_new_formats() -> None:
    assert split_style_segments("Убираем $300 рублевые$ офферы") == [
        TextStyleSegment(text="Убираем ", bg=None),
        TextStyleSegment(text="300 рублевые", bg="FFFF00"),
        TextStyleSegment(text=" офферы", bg=None),
    ]
    assert split_style_segments("[[fg:FF0000;strike::Индексация 2027]]") == [
        TextStyleSegment(text="Индексация 2027", fg="FF0000", strike=True),
    ]


def test_split_cell_wrapper() -> None:
    style, inner = split_cell_wrapper("<<cell:bg:C6EFCE;border:4472C4>>текст<<>>")
    assert style.bg == "C6EFCE"
    assert style.border == "4472C4"
    assert inner == "текст"


def test_encode_style_segment() -> None:
    assert encode_style_segment("важно", bg="FFFF00") == "$важно$"
    assert encode_style_segment("розовый", bg="FF66B2") == "{{FF66B2:розовый}}"
    assert (
        encode_style_segment("текст", fg="FF0000", strike=True)
        == "[[fg:FF0000;strike::текст]]"
    )


def test_display_cell_text_strips_markers() -> None:
    assert display_cell_text("$важно$") == "важно"
    assert display_cell_text("[[fg:FF0000;strike::зачёркнуто]]") == "зачёркнуто"
    assert display_cell_text("<<cell:bg:00FF00>>текст<<>>") == "текст"


def test_apply_text_format_runs_wraps_text_and_background_styles() -> None:
    text = "Убираем 300 рублевые офферы"
    runs = [
        {"startIndex": 0, "format": {}},
        {"startIndex": 8, "format": {"backgroundColor": {"red": 1, "green": 1, "blue": 0}}},
        {"startIndex": 21, "format": {}},
    ]
    assert apply_text_format_runs(text, runs) == "Убираем $300 рублевые $офферы"

    red_runs = [
        {"startIndex": 0, "format": {"foregroundColor": {"red": 1, "green": 0, "blue": 0}}},
        {"startIndex": 17, "format": {}},
    ]
    assert apply_text_format_runs("Индексация 2027", red_runs) == "[[fg:FF0000::Индексация 2027]]"

    strike_runs = [
        {"startIndex": 0, "format": {"strikethrough": True}},
        {"startIndex": 48, "format": {}},
    ]
    result = apply_text_format_runs("Убираем 300 рублевые офферы с анлимом из публики", strike_runs)
    assert result.startswith("[[strike::Убираем 300 рублевые офферы с анлимом из публики")


def test_cell_text_with_highlights_from_cell_background_and_border() -> None:
    cell = {
        "effectiveValue": {"stringValue": "Идет миграция"},
        "effectiveFormat": {
            "backgroundColor": {"red": 0.78, "green": 0.94, "blue": 0.81},
            "borders": {
                "top": {
                    "style": "SOLID",
                    "color": {"red": 0.27, "green": 0.45, "blue": 0.77},
                }
            },
        },
    }
    result = cell_text_with_highlights(cell)
    assert result.startswith("<<cell:")
    assert "border:" in result
    assert "Идет миграция" in result


def test_cell_highlight_colors_collects_unique_order() -> None:
    assert cell_highlight_colors("$жёлтый$ и {{FF66B2:розовый}}") == ["FFFF00", "FF66B2"]
    assert cell_highlight_colors("<<cell:bg:C6EFCE>>$жёлтый$<<>>") == ["C6EFCE", "FFFF00"]
