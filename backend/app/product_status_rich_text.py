from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass

# Legacy + новый формат: [[bg:FFFF00;fg:FF0000;strike::текст]]
STYLE_SEGMENT_PATTERN = re.compile(
    r"\[\[((?:[^;\]]|;)+)::((?:[^\[]|\[(?!\[))*?)\]\]"
    r"|\$([^$]+)\$"
    r"|\{\{([0-9A-Fa-f]{6}):([^}]*)\}\}",
)
CELL_WRAPPER_PATTERN = re.compile(r"^<<cell:([^>]+)>>(.*)<<>>$", re.DOTALL)
TABLE_TOKEN_PREFIX = "<<tablejson:"
TABLE_TOKEN_SUFFIX = ">>"


@dataclass(frozen=True)
class CellStyle:
    bg: str | None = None
    border: str | None = None


@dataclass(frozen=True)
class TextStyleSegment:
    text: str
    bg: str | None = None
    fg: str | None = None
    strike: bool = False
    bold: bool = False
    italic: bool = False


# Совместимость со старым API.
HighlightSegment = TextStyleSegment


def color_to_hex(color: dict | None) -> str | None:
    if not color:
        return None
    if "red" not in color and "green" not in color and "blue" not in color:
        return None
    red = float(color.get("red", 0) or 0)
    green = float(color.get("green", 0) or 0)
    blue = float(color.get("blue", 0) or 0)
    if red > 0.98 and green > 0.98 and blue > 0.98:
        return None
    return (
        f"{int(round(red * 255)):02X}"
        f"{int(round(green * 255)):02X}"
        f"{int(round(blue * 255)):02X}"
    )


def is_yellow_highlight_color(color: dict | None) -> bool:
    if not color:
        return False
    red = float(color.get("red", 0) or 0)
    green = float(color.get("green", 0) or 0)
    blue = float(color.get("blue", 0) or 0)
    return (
        red >= 0.7
        and green >= 0.65
        and blue <= 0.85
        and red + green > blue + 0.9
    )


def is_highlight_color(color: dict | None) -> bool:
    return color_to_hex(color) is not None


def _escape_marker_text(text: str) -> str:
    return (
        text.replace("$", "")
        .replace("{", "")
        .replace("}", "")
        .replace("[", "")
        .replace("]", "")
    )


def _parse_style_attrs(raw: str) -> dict[str, str | bool]:
    parsed: dict[str, str | bool] = {}
    for chunk in raw.split(";"):
        token = chunk.strip()
        if not token:
            continue
        if token in {"strike", "s"}:
            parsed["strike"] = True
        elif token in {"bold", "b"}:
            parsed["bold"] = True
        elif token in {"italic", "i"}:
            parsed["italic"] = True
        elif ":" in token:
            key, value = token.split(":", 1)
            parsed[key.strip()] = value.strip().upper()
    return parsed


def _attrs_to_segment(text: str, attrs: dict[str, str | bool]) -> TextStyleSegment:
    return TextStyleSegment(
        text=text,
        bg=str(attrs["bg"]).upper() if attrs.get("bg") else None,
        fg=str(attrs["fg"]).upper() if attrs.get("fg") else None,
        strike=bool(attrs.get("strike")),
        bold=bool(attrs.get("bold")),
        italic=bool(attrs.get("italic")),
    )


def encode_style_segment(
    text: str,
    *,
    bg: str | None = None,
    fg: str | None = None,
    strike: bool = False,
    bold: bool = False,
    italic: bool = False,
) -> str:
    safe = _escape_marker_text(text)
    if not safe:
        return ""
    if bg and not fg and not strike and not bold and not italic:
        if bg.upper() == "FFFF00":
            return f"${safe}$"
        return f"{{{{{bg.upper()}:{safe}}}}}"
    parts: list[str] = []
    if bg:
        parts.append(f"bg:{bg.upper()}")
    if fg:
        parts.append(f"fg:{fg.upper()}")
    if strike:
        parts.append("strike")
    if bold:
        parts.append("bold")
    if italic:
        parts.append("italic")
    if not parts:
        return safe
    return f"[[{';'.join(parts)}::{safe}]]"


def encode_highlight(text: str, color_hex: str) -> str:
    return encode_style_segment(text, bg=color_hex)


BOOLEAN_YES_BG = "C6EFCE"
BOOLEAN_NO_BG = "F4CCCC"


def _cell_display_background(encoded: str) -> str | None:
    cell_style, inner = split_cell_wrapper(encoded)
    if cell_style.bg:
        return cell_style.bg
    segments = [segment for segment in split_style_segments(inner) if segment.text]
    if len(segments) == 1 and segments[0].bg and not segments[0].fg:
        return segments[0].bg
    return None


def resolve_boolean_colors(rows: list[dict[str, str]], column: str) -> tuple[str, str]:
    yes_bg: str | None = None
    no_bg: str | None = None
    for row in rows:
        raw = (row.get(column) or "").strip()
        if not raw:
            continue
        text = display_cell_text(raw).strip().casefold()
        bg = _cell_display_background(raw)
        if not bg:
            continue
        if text == "да":
            yes_bg = yes_bg or bg
        elif text == "нет":
            no_bg = no_bg or bg
    return yes_bg or BOOLEAN_YES_BG, no_bg or BOOLEAN_NO_BG


def styled_boolean_value(checked: bool, *, yes_bg: str, no_bg: str) -> str:
    label = "да" if checked else "нет"
    bg = yes_bg if checked else no_bg
    return wrap_cell_text(label, bg=bg)


def wrap_cell_text(text: str, *, bg: str | None = None, border: str | None = None) -> str:
    if not text:
        return ""
    attrs: list[str] = []
    if bg:
        attrs.append(f"bg:{bg.upper()}")
    if border:
        attrs.append(f"border:{border.upper()}")
    if not attrs:
        return text
    return f"<<cell:{';'.join(attrs)}>>{text}<<>>"


def split_cell_wrapper(text: str) -> tuple[CellStyle, str]:
    match = CELL_WRAPPER_PATTERN.match(text or "")
    if not match:
        return CellStyle(), text
    attrs = _parse_style_attrs(match.group(1))
    return (
        CellStyle(
            bg=str(attrs["bg"]).upper() if attrs.get("bg") else None,
            border=str(attrs["border"]).upper() if attrs.get("border") else None,
        ),
        match.group(2),
    )


@dataclass(frozen=True)
class EmbeddedTableDoc:
    text: str
    cells: tuple[tuple[str, ...], ...]


def format_embedded_table_doc(parsed: object) -> str:
    if not isinstance(parsed, dict):
        return ""
    text = str(parsed.get("text") or "").strip()
    table = parsed.get("table") if isinstance(parsed.get("table"), dict) else parsed
    if not isinstance(table, dict):
        return text
    cells = table.get("cells")
    if not isinstance(cells, list):
        return text
    lines: list[str] = []
    if text:
        lines.append(text)
    for row in cells:
        if not isinstance(row, list):
            continue
        row_text = " | ".join(str(cell).strip() for cell in row)
        if row_text.replace("|", "").strip():
            lines.append(row_text)
    return "\n".join(lines)


def _normalize_embedded_table_cells(raw_cells: object, rows: int, cols: int) -> tuple[tuple[str, ...], ...]:
    source = raw_cells if isinstance(raw_cells, list) else []
    normalized: list[tuple[str, ...]] = []
    for row_index in range(max(rows, 0)):
        row = source[row_index] if row_index < len(source) and isinstance(source[row_index], list) else []
        normalized.append(
            tuple(str(row[col_index]) if col_index < len(row) else "" for col_index in range(max(cols, 0)))
        )
    return tuple(normalized)


def parse_embedded_table_doc(text: str) -> EmbeddedTableDoc | None:
    _, inner = split_cell_wrapper(text or "")
    if not inner.startswith(TABLE_TOKEN_PREFIX) or not inner.endswith(TABLE_TOKEN_SUFFIX):
        return None
    encoded = inner[len(TABLE_TOKEN_PREFIX): -len(TABLE_TOKEN_SUFFIX)]
    try:
        raw = base64.b64decode(encoded).decode("utf-8")
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    table = parsed.get("table") if isinstance(parsed.get("table"), dict) else parsed
    if not isinstance(table, dict):
        return None
    cells_raw = table.get("cells")
    if not isinstance(cells_raw, list):
        return None
    try:
        rows = int(table.get("rows") or len(cells_raw) or 0)
        cols = int(
            table.get("cols")
            or max((len(row) for row in cells_raw if isinstance(row, list)), default=0)
        )
    except (TypeError, ValueError):
        return None
    if rows < 1 or cols < 1:
        return None
    preamble = str(parsed.get("text") or "")
    return EmbeddedTableDoc(
        text=preamble,
        cells=_normalize_embedded_table_cells(cells_raw, rows, cols),
    )


def embedded_table_inner_to_plain(inner: str) -> str | None:
    if not inner.startswith(TABLE_TOKEN_PREFIX) or not inner.endswith(TABLE_TOKEN_SUFFIX):
        return None
    encoded = inner[len(TABLE_TOKEN_PREFIX): -len(TABLE_TOKEN_SUFFIX)]
    try:
        raw = base64.b64decode(encoded).decode("utf-8")
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return format_embedded_table_doc(parsed)


def display_cell_text(text: str) -> str:
    _, inner = split_cell_wrapper(text)
    table_plain = embedded_table_inner_to_plain(inner)
    if table_plain is not None:
        return table_plain
    cleaned = inner.replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")

    def _strip(match: re.Match[str]) -> str:
        if match.group(1) is not None:
            return match.group(2)
        if match.group(3) is not None:
            return match.group(3)
        return match.group(5)

    return STYLE_SEGMENT_PATTERN.sub(_strip, cleaned)


def split_style_segments(text: str) -> list[TextStyleSegment]:
    segments: list[TextStyleSegment] = []
    last = 0
    for match in STYLE_SEGMENT_PATTERN.finditer(text):
        start = match.start()
        if start > last:
            segments.append(TextStyleSegment(text=text[last:start]))
        if match.group(1) is not None:
            attrs = _parse_style_attrs(match.group(1))
            segments.append(_attrs_to_segment(match.group(2), attrs))
        elif match.group(3) is not None:
            segments.append(TextStyleSegment(text=match.group(3), bg="FFFF00"))
        else:
            segments.append(TextStyleSegment(text=match.group(5), bg=match.group(4).upper()))
        last = match.end()
    if last < len(text):
        segments.append(TextStyleSegment(text=text[last:]))
    if not segments:
        segments.append(TextStyleSegment(text=text))
    return segments


def split_highlight_segments(text: str) -> list[TextStyleSegment]:
    _, inner = split_cell_wrapper(text)
    return split_style_segments(inner)


def wrap_highlighted_text(text: str, color_hex: str = "FFFF00") -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    if STYLE_SEGMENT_PATTERN.search(stripped):
        return stripped
    return encode_highlight(stripped, color_hex)


def _format_has_style(fmt: dict) -> bool:
    return bool(
        color_to_hex(fmt.get("backgroundColor"))
        or color_to_hex(fmt.get("foregroundColor"))
        or fmt.get("strikethrough")
        or fmt.get("bold")
        or fmt.get("italic")
    )


def _segment_style_colors(fmt: dict) -> tuple[str | None, str | None]:
    fg = color_to_hex(fmt.get("foregroundColor"))
    bg = color_to_hex(fmt.get("backgroundColor"))
    # Google Sheets иногда отдаёт жёлтую подсветку вместе с цветом текста — в экспорте
    # оставляем только foreground.
    if fg and bg:
        bg = None
    return bg, fg


def _segment_from_format(text: str, fmt: dict) -> str:
    if not text:
        return ""
    bg, fg = _segment_style_colors(fmt)
    return encode_style_segment(
        _escape_marker_text(text),
        bg=bg,
        fg=fg,
        strike=bool(fmt.get("strikethrough")),
        bold=bool(fmt.get("bold")),
        italic=bool(fmt.get("italic")),
    )


def apply_text_format_runs(text: str, runs: list[dict]) -> str:
    if not text or not runs:
        return text

    ordered = sorted(runs, key=lambda item: int(item.get("startIndex", 0) or 0))
    parts: list[str] = []
    for index, run in enumerate(ordered):
        start = int(run.get("startIndex", 0) or 0)
        end = (
            int(ordered[index + 1].get("startIndex", 0) or 0)
            if index + 1 < len(ordered)
            else len(text)
        )
        if start >= len(text) or start >= end:
            continue
        segment = text[start:end]
        fmt = run.get("format") or {}
        if _format_has_style(fmt):
            encoded = _segment_from_format(segment, fmt)
            if encoded:
                parts.append(encoded)
        else:
            parts.append(segment)
    return "".join(parts) if parts else text


def _cell_border_color(fmt: dict) -> str | None:
    borders = fmt.get("borders") or {}
    for side in ("top", "bottom", "left", "right"):
        side_fmt = borders.get(side) or {}
        style = str(side_fmt.get("style", "")).upper()
        if style and style != "NONE":
            color = color_to_hex(side_fmt.get("color"))
            if color:
                return color
    return None


def _cell_format_styles(fmt: dict) -> tuple[str | None, str | None]:
    bg = color_to_hex(fmt.get("backgroundColor"))
    border = _cell_border_color(fmt)
    return bg, border


def _hex_to_google_color(hex_color: str) -> dict[str, float]:
    value = hex_color.upper()
    return {
        "red": int(value[0:2], 16) / 255.0,
        "green": int(value[2:4], 16) / 255.0,
        "blue": int(value[4:6], 16) / 255.0,
    }


def _inner_has_foreground(styled: str) -> bool:
    return any(segment.fg for segment in split_style_segments(styled))


def _filter_cell_background(cell_bg: str | None, styled: str) -> str | None:
    if not cell_bg or not _inner_has_foreground(styled):
        return cell_bg
    if is_yellow_highlight_color(_hex_to_google_color(cell_bg)):
        return None
    return cell_bg


def cell_text_with_highlights(cell: dict) -> str:
    effective = cell.get("effectiveValue") or cell.get("userEnteredValue") or {}
    if "stringValue" in effective:
        text = str(effective["stringValue"])
    elif "numberValue" in effective:
        number = effective["numberValue"]
        text = str(int(number)) if float(number).is_integer() else str(number)
    elif "boolValue" in effective:
        text = "TRUE" if effective["boolValue"] else "FALSE"
    else:
        text = str(cell.get("formattedValue") or "").strip()

    text = text.replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")
    if not text:
        return ""

    runs = cell.get("textFormatRuns") or []
    if runs:
        styled = apply_text_format_runs(text, runs)
    else:
        styled = text
        for fmt_key in ("effectiveFormat", "userEnteredFormat"):
            fmt = cell.get(fmt_key) or {}
            text_fmt = fmt.get("textFormat") or {}
            if _format_has_style(text_fmt):
                styled = _segment_from_format(text, text_fmt)
                break

    cell_bg: str | None = None
    cell_border: str | None = None
    for fmt_key in ("effectiveFormat", "userEnteredFormat"):
        fmt = cell.get(fmt_key) or {}
        bg, border = _cell_format_styles(fmt)
        cell_bg = cell_bg or bg
        cell_border = cell_border or border

    cell_bg = _filter_cell_background(cell_bg, styled)
    return wrap_cell_text(styled, bg=cell_bg, border=cell_border)


def cell_highlight_colors(text: str) -> list[str]:
    cell_style, inner = split_cell_wrapper(text)
    colors: list[str] = []
    cell_bg = _filter_cell_background(cell_style.bg, inner)
    if cell_bg:
        colors.append(cell_bg)
    for segment in split_style_segments(inner):
        if segment.bg and not segment.fg:
            colors.append(segment.bg)
    return colors
