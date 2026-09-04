import re
from dataclasses import dataclass
from datetime import date

# Лист итерации: 2026.08.11.0-R, 2026.06.17.0-R
RELEASE_LEAF_RE = re.compile(
    r"^(?P<year>\d{4})\.(?P<month>\d{2})\.(?P<day>\d{2})(?:\.\d+-[A-Za-z]+)?$",
    re.IGNORECASE,
)
# Дата внутри сегмента пути (fallback)
ITERATION_DATE_RE = re.compile(r"(?P<year>\d{4})\.(?P<month>\d{2})\.(?P<day>\d{2})")
# Квартал: Q2'26, Q2'2026, Q2 2026, Q2-26
QUARTER_LEAF_RE = re.compile(
    r"^Q(?P<quarter>[1-4])(?:[''`′]\s*|\s*[-–]?\s*)(?P<year>\d{2}|\d{4})$",
    re.IGNORECASE,
)
# Год и квартал в одном сегменте: 2026_Q3_DoC, 2026-Q2
YEAR_QUARTER_RE = re.compile(
    r"(?P<year>\d{4})[_-]Q(?P<quarter>[1-4])(?:\b|_)",
    re.IGNORECASE,
)
# Месяц.год: Dec.26, May.26
MONTH_ABBR_LEAF_RE = re.compile(
    r"^(?P<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.(?P<year>\d{2})$",
    re.IGNORECASE,
)
TBD_RE = re.compile(r"\bTBD\b", re.IGNORECASE)

_MONTH_ABBR_TO_NUM = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}

PLAN_QUARTER_TBD = "TBD"
PLAN_QUARTER_NONE = "__none__"


@dataclass(frozen=True)
class IterationPlan:
    planned_date: date | None = None
    is_tbd: bool = False
    explicit_quarter_key: str | None = None

    @property
    def quarter_key(self) -> str | None:
        if self.is_tbd:
            return PLAN_QUARTER_TBD
        if self.explicit_quarter_key:
            return self.explicit_quarter_key
        if self.planned_date:
            return quarter_key_from_date(self.planned_date)
        return None

    @property
    def quarter_label(self) -> str | None:
        if self.is_tbd:
            return "TBD"
        key = self.quarter_key
        return quarter_label_from_key(key) if key else None

    @property
    def planned_label(self) -> str | None:
        return "TBD" if self.is_tbd else None


def _path_segments(iteration_path: str) -> list[str]:
    return [part.strip() for part in iteration_path.replace("/", "\\").split("\\") if part.strip()]


def _full_year(year_token: str) -> int:
    year = int(year_token)
    if year < 100:
        return 2000 + year
    return year


def _quarter_key(year: int, quarter: int) -> str:
    return f"{year}-Q{quarter}"


def _date_from_segment(segment: str) -> date | None:
    match = RELEASE_LEAF_RE.match(segment) or ITERATION_DATE_RE.search(segment)
    if match:
        try:
            return date(int(match.group("year")), int(match.group("month")), int(match.group("day")))
        except ValueError:
            return None
    month_match = MONTH_ABBR_LEAF_RE.match(segment)
    if month_match:
        month = _MONTH_ABBR_TO_NUM[month_match.group("mon").lower()]
        year = _full_year(month_match.group("year"))
        try:
            return date(year, month, 1)
        except ValueError:
            return None
    return None


def _quarter_from_segment(segment: str, *, fallback_year: int | None = None) -> str | None:
    leaf = QUARTER_LEAF_RE.match(segment.strip())
    if leaf:
        return _quarter_key(_full_year(leaf.group("year")), int(leaf.group("quarter")))
    year_quarter = YEAR_QUARTER_RE.search(segment)
    if year_quarter:
        return _quarter_key(int(year_quarter.group("year")), int(year_quarter.group("quarter")))
    if fallback_year is not None:
        bare = re.fullmatch(r"Q([1-4])", segment.strip(), re.IGNORECASE)
        if bare:
            return _quarter_key(fallback_year, int(bare.group(1)))
    return None


def _year_from_segment(segment: str) -> int | None:
    if re.fullmatch(r"\d{4}", segment.strip()):
        return int(segment.strip())
    return None


def parse_iteration_plan(iteration_path: str | None) -> IterationPlan:
    """План из System.IterationPath: дата `2026.08.11.0-R`, квартал `Q2'26` / `2026_Q3`, TBD."""
    if not iteration_path:
        return IterationPlan()
    normalized = str(iteration_path).strip()
    if not normalized:
        return IterationPlan()

    segments = _path_segments(normalized)
    if not segments:
        return IterationPlan()

    if any(TBD_RE.search(segment) for segment in segments):
        return IterationPlan(is_tbd=True)

    for index, segment in enumerate(reversed(segments)):
        planned = _date_from_segment(segment)
        if planned:
            return IterationPlan(planned_date=planned)
        # год часто в предыдущем сегменте: ...\2026\Q2'26
        preceding = segments[-(index + 2)] if index + 2 <= len(segments) else None
        fallback_year = _year_from_segment(preceding) if preceding else None
        quarter_key = _quarter_from_segment(segment, fallback_year=fallback_year)
        if quarter_key:
            return IterationPlan(explicit_quarter_key=quarter_key)

    return IterationPlan()


def parse_planned_date_from_iteration(iteration_path: str | None) -> date | None:
    return parse_iteration_plan(iteration_path).planned_date


def quarter_key_from_date(value: date) -> str:
    quarter = (value.month - 1) // 3 + 1
    return f"{value.year}-Q{quarter}"


def quarter_label_from_key(key: str) -> str:
    if key == PLAN_QUARTER_TBD:
        return "TBD"
    year, _, quarter = key.partition("-Q")
    if year and quarter:
        return f"Q{quarter} {year}"
    return key
