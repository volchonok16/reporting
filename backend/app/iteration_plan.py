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
TBD_RE = re.compile(r"\bTBD\b", re.IGNORECASE)

PLAN_QUARTER_TBD = "TBD"
PLAN_QUARTER_NONE = "__none__"


@dataclass(frozen=True)
class IterationPlan:
    planned_date: date | None = None
    is_tbd: bool = False

    @property
    def quarter_key(self) -> str | None:
        if self.is_tbd:
            return PLAN_QUARTER_TBD
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


def _date_from_segment(segment: str) -> date | None:
    match = RELEASE_LEAF_RE.match(segment) or ITERATION_DATE_RE.search(segment)
    if not match:
        return None
    try:
        return date(int(match.group("year")), int(match.group("month")), int(match.group("day")))
    except ValueError:
        return None


def parse_iteration_plan(iteration_path: str | None) -> IterationPlan:
    """План из System.IterationPath: дата из `2026.08.11.0-R` или метка TBD."""
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

    for segment in reversed(segments):
        planned = _date_from_segment(segment)
        if planned:
            return IterationPlan(planned_date=planned)

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
