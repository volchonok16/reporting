import re
from datetime import date

ITERATION_DATE_RE = re.compile(r"(?P<year>\d{4})\.(?P<month>\d{2})\.(?P<day>\d{2})")


def parse_planned_date_from_iteration(iteration_path: str | None) -> date | None:
    """Дата из листа итерации, напр. `2026.08.11.0-R` → 2026-08-11."""
    if not iteration_path:
        return None
    normalized = str(iteration_path).strip()
    if not normalized:
        return None
    leaf = normalized.replace("/", "\\").split("\\")[-1].strip()
    match = ITERATION_DATE_RE.search(leaf) or ITERATION_DATE_RE.search(normalized)
    if not match:
        return None
    try:
        return date(int(match.group("year")), int(match.group("month")), int(match.group("day")))
    except ValueError:
        return None


def quarter_key_from_date(value: date) -> str:
    quarter = (value.month - 1) // 3 + 1
    return f"{value.year}-Q{quarter}"


def quarter_label_from_key(key: str) -> str:
    year, _, quarter = key.partition("-Q")
    if year and quarter:
        return f"Q{quarter} {year}"
    return key
