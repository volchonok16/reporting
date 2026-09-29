from datetime import date

from app.models import Task, ZniExternalData
from app.report_service import _change_request_to_out, _effective_actual_period


def _zni(**kwargs) -> Task:
    defaults = {
        "id": 1,
        "source_system_id": 1,
        "project_id": 1,
        "external_id": "441181",
        "title": "Test",
        "task_type": "change_request",
        "source_team": "CORE",
        "extra_json": {"board_code": "b2b_product_core"},
    }
    defaults.update(kwargs)
    return Task(**defaults)


def test_missing_customer_flag_and_desired_from_plan() -> None:
    row = _zni(
        extra_json={
            "board_code": "b2b_product_core",
            "planned_date": "2026-04-15",
        }
    )
    out = _change_request_to_out(row, [])
    assert out.missingCustomer is True
    assert out.customerName is None
    assert out.desiredDateFromPlan is True
    assert out.externalDesiredDate == date(2026, 4, 15)


def test_actual_period_from_pilot_transition() -> None:
    row = _zni(
        extra_json={
            "board_code": "b2b_product_core",
            "customer_name": "Иванов",
            "pilot_transitions": [{"at": "2026-03-10T12:00:00+03:00", "status": "Pilot"}],
        }
    )
    out = _change_request_to_out(row, [])
    assert out.missingCustomer is False
    assert out.actualPeriodFromPilot is True
    assert out.actualPeriodFromClosed is False
    assert out.externalActualPeriod == "2026-03-10"
    assert out.pilotEnteredAt == date(2026, 3, 10)


def test_actual_period_from_closed_when_status_closed() -> None:
    row = _zni(
        source_status="Closed",
        extra_json={
            "board_code": "b2b_product_core",
            "customer_name": "Иванов",
            "board_column": "Closed",
            "pilot_transitions": [{"at": "2026-03-10T12:00:00+03:00", "status": "Pilot"}],
            "closed_transitions": [{"at": "2026-06-20T09:00:00+03:00", "status": "Closed"}],
        },
    )
    out = _change_request_to_out(row, [])
    assert out.actualPeriodFromClosed is True
    assert out.actualPeriodFromPilot is False
    assert out.externalActualPeriod == "2026-06-20"


def test_stored_actual_period_wins_over_pilot_and_closed() -> None:
    row = _zni(
        source_status="Closed",
        extra_json={
            "board_code": "b2b_product_core",
            "customer_name": "Иванов",
            "pilot_transitions": [{"at": "2026-03-10T12:00:00+03:00", "status": "Pilot"}],
            "closed_transitions": [{"at": "2026-06-20T09:00:00+03:00", "status": "Closed"}],
        },
    )
    external = ZniExternalData(task_id=1, actual_period="2026-Q1")
    value, from_pilot, from_closed = _effective_actual_period(row, external)
    assert value == "2026-Q1"
    assert from_pilot is False
    assert from_closed is False
