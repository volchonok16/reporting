from datetime import date

from app.iteration_plan import (
    PLAN_QUARTER_TBD,
    parse_iteration_plan,
    parse_planned_date_from_iteration,
    quarter_key_from_date,
    quarter_label_from_key,
)


def test_parse_planned_date_from_digital_iteration() -> None:
    path = r"Tele2\Общие\Digital\2026\2026.08.11.0-R"
    assert parse_planned_date_from_iteration(path) == date(2026, 8, 11)


def test_parse_release_leaf_only() -> None:
    assert parse_iteration_plan("2026.08.11.0-R").planned_date == date(2026, 8, 11)


def test_parse_tbd_iteration() -> None:
    plan = parse_iteration_plan(r"Tele2\Общие\Digital\2026\TBD")
    assert plan.is_tbd
    assert plan.planned_date is None
    assert plan.quarter_key == PLAN_QUARTER_TBD
    assert plan.planned_label == "TBD"
    assert plan.quarter_label == "TBD"


def test_quarter_from_planned_date() -> None:
    assert quarter_key_from_date(date(2026, 8, 11)) == "2026-Q3"
    assert quarter_label_from_key("2026-Q3") == "Q3 2026"
    assert quarter_label_from_key(PLAN_QUARTER_TBD) == "TBD"


def test_parse_empty_iteration() -> None:
    assert parse_planned_date_from_iteration(None) is None
    assert parse_planned_date_from_iteration("") is None


def test_parse_quarter_apostrophe_leaf() -> None:
    plan = parse_iteration_plan(r"Tele2\B2B Product\2026\Q2'26")
    assert plan.planned_date is None
    assert plan.is_tbd is False
    assert plan.quarter_key == "2026-Q2"
    assert plan.quarter_label == "Q2 2026"


def test_parse_year_quarter_segment() -> None:
    plan = parse_iteration_plan(r"Tele2\DocOut\2026_Q3_DoC")
    assert plan.quarter_key == "2026-Q3"
    assert plan.quarter_label == "Q3 2026"


def test_parse_month_abbr_leaf() -> None:
    plan = parse_iteration_plan(r"Tele2\Something\Dec.26")
    assert plan.planned_date == date(2026, 12, 1)
    assert plan.quarter_key == "2026-Q4"
