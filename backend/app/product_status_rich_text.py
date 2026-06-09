from __future__ import annotations

import re

HIGHLIGHT_MARKER_PATTERN = re.compile(r"\$([^$]+)\$")


def is_yellow_highlight_color(color: dict | None) -> bool:
    """Жёлтая заливка / маркер из Google Sheets (RGB 0..1)."""
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


def display_cell_text(text: str) -> str:
    """Текст без маркеров $...$ — для отображения и оценки высоты."""
    cleaned = (text or "").replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")
    return HIGHLIGHT_MARKER_PATTERN.sub(r"\1", cleaned)


def split_highlight_segments(text: str) -> list[tuple[str, bool]]:
    segments: list[tuple[str, bool]] = []
    last = 0
    for match in HIGHLIGHT_MARKER_PATTERN.finditer(text):
        if match.start() > last:
            segments.append((text[last : match.start()], False))
        segments.append((match.group(1), True))
        last = match.end()
    if last < len(text):
        segments.append((text[last:], False))
    if not segments:
        segments.append((text, False))
    return segments


def wrap_highlighted_text(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    if "$" in stripped:
        return stripped
    return f"${stripped}$"


def _escape_marker_text(text: str) -> str:
    return text.replace("$", "")


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
        if is_yellow_highlight_color(fmt.get("backgroundColor")):
            safe = _escape_marker_text(segment)
            if safe:
                parts.append(f"${safe}$")
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
        if is_yellow_highlight_color(fmt.get("backgroundColor")):
            return wrap_highlighted_text(text)

    return text
