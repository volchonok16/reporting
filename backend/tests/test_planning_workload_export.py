from datetime import date
from decimal import Decimal

from app.planning_schemas import (
    PlanningWorkloadAllocationCell,
    PlanningWorkloadDayCell,
    PlanningWorkloadEmployeeOut,
    PlanningWorkloadOut,
)
from app.planning_workload_export import _iter_export_rows, export_workload_csv, export_workload_xlsx


def _sample_workload() -> PlanningWorkloadOut:
    day = date(2026, 3, 2)
    return PlanningWorkloadOut(
        dateFrom=day,
        dateTo=day,
        days=[day],
        employees=[
            PlanningWorkloadEmployeeOut(
                id=1,
                fullName="Иванов",
                dailyWorkHours=Decimal("8"),
                expertises=["Backend"],
                departmentNames=["CORE"],
                days={
                    day.isoformat(): PlanningWorkloadDayCell(
                        capacityHours=Decimal("8"),
                        plannedHours=Decimal("6"),
                        actualHours=Decimal("2"),
                        availableHours=Decimal("2"),
                        isWorkingDay=True,
                        timeOffKind=None,
                        allocations=[
                            PlanningWorkloadAllocationCell(
                                allocationId=10,
                                projectId=5,
                                requestNumber="123",
                                requestName="Проект А",
                                plannedHours=Decimal("6"),
                                actualHours=Decimal("2"),
                            )
                        ],
                    )
                },
            )
        ],
    )


def test_workload_export_rows_summary_and_by_project() -> None:
    workload = _sample_workload()
    summary_rows = _iter_export_rows(workload, view_mode="summary")
    assert len(summary_rows) == 1
    assert summary_rows[0][3] == "Итого"
    assert summary_rows[0][7] == "6"

    project_rows = _iter_export_rows(workload, view_mode="byProject")
    assert len(project_rows) == 2
    assert project_rows[1][3] == "Проект"
    assert project_rows[1][4] == "123"


def test_workload_export_files_are_non_empty() -> None:
    workload = _sample_workload()
    day = date(2026, 3, 2)
    csv_bytes, csv_name = export_workload_csv(
        workload, view_mode="byProject", date_from=day, date_to=day
    )
    xlsx_bytes, xlsx_name = export_workload_xlsx(
        workload, view_mode="summary", date_from=day, date_to=day
    )
    assert csv_name.endswith(".csv")
    assert xlsx_name.endswith(".xlsx")
    assert csv_bytes.startswith(b"\xef\xbb\xbf")
    assert "ФИО".encode("utf-8") in csv_bytes
    assert xlsx_bytes[:2] == b"PK"
