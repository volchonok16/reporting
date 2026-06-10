"""Исключение ЗНИ по маркерам в названии (System.Title)."""

from __future__ import annotations

ZNI_TITLE_EXCLUDE_PATTERNS: tuple[str, ...] = (
    "[Мобильная карусель]",
    "[VOICE TARGET]",
)


def is_excluded_zni_title(title: str | None) -> bool:
    if not title:
        return False
    normalized = title.casefold()
    return any(pattern.casefold() in normalized for pattern in ZNI_TITLE_EXCLUDE_PATTERNS)
