from datetime import date, timedelta

FIXED_HOLIDAY_MD = frozenset(
    {
        "01-01",
        "01-02",
        "01-03",
        "01-04",
        "01-05",
        "01-06",
        "01-07",
        "01-08",
        "02-23",
        "03-08",
        "05-01",
        "05-09",
        "06-12",
        "11-04",
    }
)

YEAR_EXTRA_MD: dict[int, tuple[str, ...]] = {
    2024: ("05-10", "12-31"),
    2025: ("01-09", "05-02", "05-08", "06-13", "11-03", "12-31"),
    2026: ("01-09", "12-31"),
}


def _month_day_key(day: date) -> str:
    return f"{day.month:02d}-{day.day:02d}"


def is_ru_public_holiday(day: date) -> bool:
    md = _month_day_key(day)
    if md in FIXED_HOLIDAY_MD:
        return True
    return md in YEAR_EXTRA_MD.get(day.year, ())


def iter_days(start: date, end: date):
    cursor = start
    while cursor <= end:
        yield cursor
        cursor += timedelta(days=1)


def default_is_working_day(day: date) -> bool:
    if day.weekday() >= 5:
        return False
    return not is_ru_public_holiday(day)
