"""Заявленный квартал ЗНИ (локальное поле, не квартал итерации TFS)."""

from __future__ import annotations

import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

_MOSCOW = ZoneInfo("Europe/Moscow")
_CANONICAL = re.compile(r"^(\d{4})-Q([1-4])$")
_COMPACT = re.compile(r"^(\d{4})Q([1-4])$")
_LEADING_Q = re.compile(r"^Q([1-4])[-/]?(\d{4})$")


def moscow_today() -> date:
    return datetime.now(_MOSCOW).date()


def normalize_plan_quarter(value: str | None) -> str | None:
    """Пустое значение сбрасывает поле. Иначе канон ``YYYY-Qn``."""
    if value is None:
        return None
    text = re.sub(r"\s+", "", value).upper()
    if not text:
        return None
    year: str | None = None
    quarter: str | None = None
    for pattern, year_group, quarter_group in (
        (_CANONICAL, 1, 2),
        (_COMPACT, 1, 2),
        (_LEADING_Q, 2, 1),
    ):
        match = pattern.fullmatch(text)
        if match:
            year = match.group(year_group)
            quarter = match.group(quarter_group)
            break
    if year is None or quarter is None:
        raise ValueError("Заявленный квартал: укажите год и Q1–Q4, например 2026-Q1")
    return f"{year}-Q{quarter}"


def parse_plan_quarter(value: str | None) -> tuple[int, int] | None:
    if not value:
        return None
    match = _CANONICAL.fullmatch(value.strip().upper())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def plan_quarter_end(year: int, quarter: int) -> date:
    month = quarter * 3
    if month == 12:
        return date(year, 12, 31)
    next_month = date(year, month + 1, 1)
    return date.fromordinal(next_month.toordinal() - 1)


def format_plan_quarter_label(value: str | None) -> str:
    parsed = parse_plan_quarter(value)
    if parsed is None:
        return ""
    year, quarter = parsed
    return f"Q{quarter} {year}"


def plan_quarter_is_overdue(
    value: str | None,
    *,
    closed_on: date | None,
    today: date | None = None,
) -> bool:
    """Квартал прошёл, а ЗНИ не закрыта в его последний день или раньше."""
    parsed = parse_plan_quarter(value)
    if parsed is None:
        return False
    end = plan_quarter_end(*parsed)
    if closed_on is not None and closed_on <= end:
        return False
    current = today or moscow_today()
    if closed_on is None:
        return current > end
    return closed_on > end
