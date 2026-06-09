from __future__ import annotations

import re
from dataclasses import dataclass

HIGHLIGHT_MARKER_PATTERN = re.compile(
    r"\$([^$]+)\$|\{\{([0-9A-Fa-f]{6}):([^}]*)\}\}",
)


@dataclass(frozen=True)
class HighlightSegment:
    text: str
    color: str | None = None


def color_to_hex(color: dict | None) -> str | None:
    """RGB Google Sheets (0..1) → RRGGBB; None если заливки нет или она белая."""
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


def encode_highlight(text: str, color_hex: str) -> str:
    safe = text.replace("$", "").replace("{", "").replace("}", "")
    color = color_hex.upper()
    if color == "FFFF00":
        return f"${safe}$"
    return f"{{{{{color}:{safe}}}}}"


def display_cell_text(text: str) -> str:
    """Текст без маркеров подсветки — для отображения и оценки высоты."""
    cleaned = (text or "").replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")

    def _strip(match: re.Match[str]) -> str:
        if match.group(1) is not None:
            return match.group(1)
        return match.group(3)

    return HIGHLIGHT_MARKER_PATTERN.sub(_strip, cleaned)


def split_highlight_segments(text: str) -> list[HighlightSegment]:
    segments: list[HighlightSegment] = []
    last = 0
    for match in HIGHLIGHT_MARKER_PATTERN.finditer(text):
        start = match.start()
        if start > last:
            segments.append(HighlightSegment(text=text[last:start], color=None))
        if match.group(1) is not None:
            segments.append(HighlightSegment(text=match.group(1), color="FFFF00"))
        else:
            segments.append(
                HighlightSegment(text=match.group(3), color=match.group(2).upper()),
            )
        last = match.end()
    if last < len(text):
        segments.append(HighlightSegment(text=text[last:], color=None))
    if not segments:
        segments.append(HighlightSegment(text=text, color=None))
    return segments


def wrap_highlighted_text(text: str, color_hex: str = "FFFF00") -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    if HIGHLIGHT_MARKER_PATTERN.search(stripped):
        return stripped
    return encode_highlight(stripped, color_hex)


def _escape_marker_text(text: str) -> str:
    return text.replace("$", "").replace("{", "").replace("}", "")


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
        color_hex = color_to_hex(fmt.get("backgroundColor"))
        if color_hex:
            safe = _escape_marker_text(segment)
            if safe:
                parts.append(encode_highlight(safe, color_hex))
        else:
            parts.append(segment)
    return "".join(parts) if parts else text


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
        highlighted = apply_text_format_runs(text, runs)
        if highlighted != text:
            return highlighted

    for fmt_key in ("userEnteredFormat", "effectiveFormat"):
        fmt = cell.get(fmt_key) or {}
        color_hex = color_to_hex(fmt.get("backgroundColor"))
        if color_hex:
            return wrap_highlighted_text(text, color_hex)

    return text


def cell_highlight_colors(text: str) -> list[str]:
    return [segment.color for segment in split_highlight_segments(text) if segment.color]
