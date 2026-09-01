"""Исключение ЗНИ по маркерам в названии (System.Title)."""

from __future__ import annotations

import re

# Только точный маркер [EFO]. Другие префиксы в скобках ([voice], [sms], …) загружаем.
ZNI_TITLE_EXCLUDE_PATTERNS: tuple[str, ...] = ("[EFO]",)


def _exclude_marker(pattern: str) -> str:
    text = pattern.strip()
    if len(text) >= 3 and text.startswith("[") and text.endswith("]"):
        return text[1:-1]
    return text


_EXCLUDE_TITLE_RE = re.compile(
    r"\[("
    + "|".join(re.escape(_exclude_marker(pattern)) for pattern in ZNI_TITLE_EXCLUDE_PATTERNS)
    + r")\]",
    re.IGNORECASE,
)


def title_pattern_is_wiql_safe(pattern: str) -> bool:
    """В WIQL CONTAINS квадратные скобки читаются как имя поля — такие шаблоны только в Python."""
    return "[" not in pattern and "]" not in pattern


def is_excluded_zni_title(title: str | None) -> bool:
    if not title:
        return False
    return _EXCLUDE_TITLE_RE.search(title) is not None
