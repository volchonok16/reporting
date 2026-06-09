"""Парсинг описания ЗНИ и поля «Заказчик ЗНИ» из TFS."""

from __future__ import annotations

import re
from html import unescape
from typing import Any

_SECTION_HEADER_RE = re.compile(
    r"<(?:b|strong)(?:\s[^>]*)?>\s*(.*?)\s*</(?:b|strong)>"
    r"(.*?)(?=<(?:b|strong)(?:\s[^>]*)?>|$)",
    re.IGNORECASE | re.DOTALL,
)
_START_SECTION_RE = re.compile(
    r"^цель\s+и\s+бизнес[-\s]*смысл\s+доработки",
    re.IGNORECASE,
)
_PLAIN_GOAL_HEADER_RE = re.compile(
    r"(?:^|[\n\r]|>|\s)\s*(?:<[^>]+>\s*)*"
    r"цель\s+и\s+бизнес[-\s]*смысл\s+доработки\s*\*?",
    re.IGNORECASE,
)
_GOAL_INLINE_AFTER_HEADER_RE = re.compile(
    r"^цель\s+и\s+бизнес[-\s]*смысл\s+доработки\s*\*?\s*(.*)$",
    re.IGNORECASE | re.DOTALL,
)
# Следующие секции шаблона ЗНИ — иногда без <b>, только текст после <br>/<div>.
_FOLLOWING_SECTION_RE = re.compile(
    r"(?:"
    r"<(?:b|strong)(?:\s[^>]*)?>\s*(?:"
    r"детальные\s+требования\s+к\s+изменению"
    r"|ценность\s+доработки"
    r"|use-cases\s*\("
    r")"
    r"|(?:^|[\n\r]|(?:<br\s*/?>\s*)+|(?:</div>\s*)+|<div[^>]*>\s*)+"
    r"(?:<[^>]+>\s*)*"
    r"(?:"
    r"детальные\s+требования\s+к\s+изменению"
    r"|ценность\s+доработки(?:/ожидаемый\s+эффект)?"
    r"|use-cases\s*\("
    r")"
    r")",
    re.IGNORECASE | re.DOTALL,
)
_FOLLOWING_SECTION_TEXT_RE = re.compile(
    r"(?:"
    r"(?:^|\n)\s*(?:"
    r"детальные\s+требования\s+к\s+изменению"
    r"|ценность\s+доработки(?:/ожидаемый\s+эффект)?"
    r"|use-cases\s*\("
    r")"
    r"|\s+(?:"
    r"детальные\s+требования\s+к\s+изменению\s*\*"
    r"|ценность\s+доработки(?:/ожидаемый\s+эффект)?\s*\*"
    r"|use-cases\s*\("
    r"))",
    re.IGNORECASE,
)


def tfs_identity_display_name(value: Any) -> str | None:
    """ФИО из identity ref TFS: dict с displayName или строка `Иванов Иван <T2RU\\user>`."""
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        for key in ("displayName", "DisplayName", "name"):
            candidate = value.get(key)
            if candidate not in (None, ""):
                return str(candidate).strip() or None
        return None

    text = str(value).strip()
    if text.startswith("{") and "displayName" in text:
        match = re.search(r"""['"]displayName['"]\s*:\s*['"]([^'"]+)['"]""", text)
        if match:
            return match.group(1).strip() or None

    if "<" in text:
        text = text.split("<", 1)[0].strip()
    return text or None


def _normalize_header(header: str) -> str:
    text = unescape(re.sub(r"<[^>]+>", "", header))
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text.rstrip("*").strip()


def _html_to_text(fragment: str) -> str:
    if not fragment:
        return ""
    text = fragment
    text = re.sub(r"(?:<br\s*/?>\s*){2,}", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</div>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</li>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _strip_following_sections_html(fragment: str) -> str:
    if not fragment:
        return ""
    match = _FOLLOWING_SECTION_RE.search(fragment)
    if match:
        return fragment[: match.start()]
    return fragment


def _strip_following_sections_text(text: str) -> str:
    if not text:
        return ""
    match = _FOLLOWING_SECTION_TEXT_RE.search(text)
    if match:
        return text[: match.start()].strip()
    return text.strip()


def _goal_inline_from_header(header: str) -> str:
    text = unescape(re.sub(r"<[^>]+>", "", header)).strip()
    match = _GOAL_INLINE_AFTER_HEADER_RE.match(text)
    return match.group(1).strip() if match else ""


def _combine_goal_parts(header: str, body: str) -> str:
    parts: list[str] = []
    inline = _goal_inline_from_header(header)
    if inline:
        parts.append(inline)
    body_text = body.strip()
    if body_text:
        parts.append(body_text)
    return "\n\n".join(parts)


def _finalize_goal_text(raw_body: str) -> str | None:
    raw_body = _strip_following_sections_html(raw_body)
    text = _strip_following_sections_text(_html_to_text(raw_body))
    return text or None


def parse_description_sections(html: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    for match in _SECTION_HEADER_RE.finditer(html):
        header = unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip()
        body = _html_to_text(match.group(2))
        sections.append((header, body))
    return sections


def extract_business_goal_from_description(html: str | None) -> str | None:
    """
    Только текст секции «Цель и бизнес-смысл доработки*» из System.Description.
    Следующие секции (требования, use-cases, ценность и т.д.) не включаются.
    """
    if not html or not str(html).strip():
        return None

    content = str(html)

    for match in _SECTION_HEADER_RE.finditer(content):
        header = unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip()
        if _START_SECTION_RE.match(_normalize_header(header)):
            combined = _combine_goal_parts(header, match.group(2))
            if combined:
                return _finalize_goal_text(combined)
            return None

    for match in _PLAIN_GOAL_HEADER_RE.finditer(content):
        return _finalize_goal_text(content[match.end() :])

    return None
