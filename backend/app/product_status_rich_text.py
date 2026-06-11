from __future__ import annotations

import re
from dataclasses import dataclass

# Legacy + новый формат: [[bg:FFFF00;fg:FF0000;strike::текст]]
STYLE_SEGMENT_PATTERN = re.compile(
    r"\[\[((?:[^;\]]|;)+)::((?:[^\[]|\[(?!\[))*?)\]\]"
    r"|\$([^$]+)\$"
    r"|\{\{([0-9A-Fa-f]{6}):([^}]*)\}\}",
)
CELL_WRAPPER_PATTERN = re.compile(r"^<<cell:([^>]+)>>(.*)<<>>$", re.DOTALL)


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


def display_cell_text(text: str) -> str:
    _, inner = split_cell_wrapper(text)
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

    return wrap_cell_text(styled, bg=cell_bg, border=cell_border)


def cell_highlight_colors(text: str) -> list[str]:
    cell_style, inner = split_cell_wrapper(text)
    colors: list[str] = []
    if cell_style.bg:
        colors.append(cell_style.bg)
    for segment in split_style_segments(inner):
        if segment.bg and not segment.fg:
            colors.append(segment.bg)
    return colors
