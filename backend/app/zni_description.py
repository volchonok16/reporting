"""Парсинг описания ЗНИ и поля «Заказчик ЗНИ» из TFS."""

from __future__ import annotations

import re
from html import unescape
from typing import Any

_SECTION_HEADER_RE = re.compile(
    r"<b>\s*(.*?)\s*</b>(.*?)(?=<b>|$)",
    re.IGNORECASE | re.DOTALL,
)
_END_SECTION_RE = re.compile(r"ценность\s+доработки", re.IGNORECASE)
_START_SECTION_RE = re.compile(
    r"^цель\s+и\s+бизнес[-\s]*смысл\s+доработки",
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
    text = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.IGNORECASE)
    text = re.sub(r"</div>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text)
    text = text.replace("\xa0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_description_sections(html: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    for match in _SECTION_HEADER_RE.finditer(html):
        header = unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip()
        body = _html_to_text(match.group(2))
        sections.append((header, body))
    return sections


def extract_business_goal_from_description(html: str | None) -> str | None:
    """
    Текст от «Цель и бизнес-смысл доработки*» до «Ценность доработки…» (не включая).
    Промежуточные секции описания тоже включаются.
    """
    if not html or not str(html).strip():
        return None

    sections = parse_description_sections(str(html))
    if not sections:
        return None

    collecting = False
    blocks: list[str] = []
    for header, body in sections:
        normalized = _normalize_header(header)
        if not collecting:
            if _START_SECTION_RE.match(normalized):
                collecting = True
                if body:
                    blocks.append(body)
            continue
        if _END_SECTION_RE.search(normalized):
            break
        if body:
            clean_header = header.rstrip("*").strip()
            if _START_SECTION_RE.match(normalized):
                blocks.append(body)
            else:
                blocks.append(f"{clean_header}\n{body}")

    if not blocks:
        return None
    return "\n\n".join(blocks).strip() or None
