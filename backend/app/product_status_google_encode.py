from __future__ import annotations

from app.product_status_rich_text import (
    CellStyle,
    TextStyleSegment,
    split_cell_wrapper,
    split_style_segments,
)


def hex_to_google_color(color_hex: str) -> dict[str, float]:
    value = color_hex.upper().lstrip("#")
    if len(value) != 6:
        raise ValueError(f"Invalid color hex: {color_hex}")
    return {
        "red": int(value[0:2], 16) / 255,
        "green": int(value[2:4], 16) / 255,
        "blue": int(value[4:6], 16) / 255,
    }


def _segment_to_google_format(segment: TextStyleSegment) -> dict:
    fmt: dict = {}
    if segment.bg:
        fmt["backgroundColor"] = hex_to_google_color(segment.bg)
    if segment.fg:
        fmt["foregroundColor"] = hex_to_google_color(segment.fg)
    if segment.strike:
        fmt["strikethrough"] = True
    if segment.bold:
        fmt["bold"] = True
    if segment.italic:
        fmt["italic"] = True
    return fmt


def _formats_equal(left: dict, right: dict) -> bool:
    return left == right


def segments_to_text_format_runs(segments: list[TextStyleSegment]) -> list[dict] | None:
    runs: list[dict] = []
    index = 0
    previous_fmt: dict | None = None
    for segment in segments:
        if not segment.text:
            continue
        fmt = _segment_to_google_format(segment)
        if index == 0 or not _formats_equal(fmt, previous_fmt or {}):
            runs.append({"startIndex": index, "format": fmt})
            previous_fmt = fmt
        index += len(segment.text)

    if not runs:
        return None
    if len(runs) == 1 and not runs[0].get("format"):
        return None
    return runs


def _cell_border_format(color_hex: str) -> dict:
    color = hex_to_google_color(color_hex)
    side = {"style": "SOLID", "color": color}
    return {
        "borders": {
            "top": side,
            "bottom": side,
            "left": side,
            "right": side,
        }
    }


def cell_style_to_google_format(cell_style: CellStyle) -> dict:
    fmt: dict = {}
    if cell_style.bg:
        fmt["backgroundColor"] = hex_to_google_color(cell_style.bg)
    if cell_style.border:
        fmt.update(_cell_border_format(cell_style.border))
    return fmt


def encoded_cell_to_google(encoded: str) -> dict:
    cell_style, inner = split_cell_wrapper(encoded or "")
    segments = split_style_segments(inner)
    plain_text = "".join(segment.text for segment in segments)

    cell_data: dict = {"userEnteredValue": {"stringValue": plain_text}}

    runs = segments_to_text_format_runs(segments)
    if runs:
        cell_data["textFormatRuns"] = runs

    user_format = cell_style_to_google_format(cell_style)
    if user_format:
        cell_data["userEnteredFormat"] = user_format

    return cell_data


def sheet_grid_to_google_rows(
    columns: list[str],
    rows: list[dict[str, str]],
) -> list[dict]:
    grid_rows: list[dict] = []

    header_cells = [
        {"userEnteredValue": {"stringValue": column}, "userEnteredFormat": {"textFormat": {"bold": True}}}
        for column in columns
    ]
    grid_rows.append({"values": header_cells})

    for row in rows:
        values = [encoded_cell_to_google((row.get(column) or "").strip()) for column in columns]
        grid_rows.append({"values": values})

    return grid_rows
