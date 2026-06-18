from __future__ import annotations

import re

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


def _segment_to_google_text_format(segment: TextStyleSegment) -> dict:
    """TextFormatRun.format — только TextFormat; backgroundColor API не принимает."""
    fmt: dict = {}
    if segment.fg:
        fmt["foregroundColor"] = hex_to_google_color(segment.fg)
    if segment.strike:
        fmt["strikethrough"] = True
    if segment.bold:
        fmt["bold"] = True
    if segment.italic:
        fmt["italic"] = True
    return fmt


def _full_cell_highlight_bg(segments: list[TextStyleSegment]) -> str | None:
    """Если весь текст ячейки — одна фоновая подсветка без других стилей."""
    if not segments:
        return None
    bg: str | None = None
    for segment in segments:
        if not segment.text:
            continue
        if segment.fg or segment.strike or segment.bold or segment.italic:
            return None
        if segment.bg:
            normalized = segment.bg.upper()
            if bg is None:
                bg = normalized
            elif bg != normalized:
                return None
        else:
            return None
    return bg


def _formats_equal(left: dict, right: dict) -> bool:
    return left == right


def segments_to_text_format_runs(segments: list[TextStyleSegment]) -> list[dict] | None:
    runs: list[dict] = []
    index = 0
    previous_fmt: dict | None = None
    for segment in segments:
        if not segment.text:
            continue
        fmt = _segment_to_google_text_format(segment)
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


def is_date_column(column: str | None) -> bool:
    if not column:
        return False
    key = column.strip().casefold()
    return key == "дата" or key.startswith("дата")


def plain_cell_text(encoded: str) -> str:
    _, inner = split_cell_wrapper(encoded or "")
    segments = split_style_segments(inner)
    return "".join(segment.text for segment in segments)


def _is_zni_column(column: str) -> bool:
    return column.strip().casefold() == "зни"


def _parse_integer_text(text: str) -> int | None:
    stripped = text.strip()
    if not stripped:
        return None
    if re.fullmatch(r"\d+\.0+", stripped):
        stripped = re.sub(r"\.0+$", "", stripped)
    if not re.fullmatch(r"\d+", stripped):
        return None
    return int(stripped)


def _segments_are_unstyled(segments: list[TextStyleSegment]) -> bool:
    for segment in segments:
        if segment.fg or segment.strike or segment.bold or segment.italic or segment.bg:
            return False
    return True


def _user_entered_value(
    plain_text: str,
    segments: list[TextStyleSegment],
    *,
    column: str | None,
) -> dict:
    if column and is_date_column(column):
        return {"stringValue": plain_text}
    use_integer = bool(column and _is_zni_column(column))
    if not use_integer and column is None:
        use_integer = _segments_are_unstyled(segments) and _parse_integer_text(plain_text) is not None
    if use_integer:
        number = _parse_integer_text(plain_text)
        if number is not None:
            return {"numberValue": number}
    return {"stringValue": plain_text}


def encoded_cell_to_google(encoded: str, *, column: str | None = None) -> dict:
    cell_style, inner = split_cell_wrapper(encoded or "")
    segments = split_style_segments(inner)
    plain_text = "".join(segment.text for segment in segments)

    cell_data: dict = {
        "userEnteredValue": _user_entered_value(plain_text, segments, column=column),
    }

    resolved_cell_style = cell_style
    uniform_bg = _full_cell_highlight_bg(segments)
    if uniform_bg and not cell_style.bg:
        resolved_cell_style = CellStyle(bg=uniform_bg, border=cell_style.border)

    runs = segments_to_text_format_runs(segments)
    if runs and not uniform_bg:
        cell_data["textFormatRuns"] = runs

    user_format = cell_style_to_google_format(resolved_cell_style)
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
        values = [
            encoded_cell_to_google((row.get(column) or "").strip(), column=column)
            for column in columns
        ]
        grid_rows.append({"values": values})

    return grid_rows
