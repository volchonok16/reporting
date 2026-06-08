from datetime import date

from app.iteration_plan import (
    parse_planned_date_from_iteration,
    quarter_key_from_date,
    quarter_label_from_key,
)


def test_parse_planned_date_from_digital_iteration() -> None:
    path = r"Tele2\Общие\Digital\2026\2026.08.11.0-R"
    assert parse_planned_date_from_iteration(path) == date(2026, 8, 11)


def test_quarter_from_planned_date() -> None:
    assert quarter_key_from_date(date(2026, 8, 11)) == "2026-Q3"
    assert quarter_label_from_key("2026-Q3") == "Q3 2026"


def test_parse_empty_iteration() -> None:
    assert parse_planned_date_from_iteration(None) is None
    assert parse_planned_date_from_iteration("") is None
