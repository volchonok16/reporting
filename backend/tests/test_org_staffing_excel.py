from __future__ import annotations

import io
from decimal import Decimal

from openpyxl import load_workbook

from app.org_schemas import (
    DepartmentOut,
    EmployeeDepartmentBriefOut,
    EmployeeExpertiseOut,
    EmployeeOut,
)
from app.org_staffing_excel import generate_staffing_excel


def _employee(
    *,
    emp_id: int,
    name: str,
    departments: list[EmployeeDepartmentBriefOut],
    is_org_head: bool = False,
) -> EmployeeOut:
    return EmployeeOut(
        id=emp_id,
        publicId=f"00000000-0000-0000-0000-{emp_id:012d}",
        fullName=name,
        email=f"{name.split()[0].lower()}@example.com",
        position="Инженер",
        managerName="Руководитель",
        dailyWorkHours=Decimal("8"),
        isActive=True,
        isOrganizationHead=is_org_head,
        expertises=[
            EmployeeExpertiseOut(id=1, directionId=1, directionName="Backend", level="Senior"),
        ],
        departments=departments,
    )


def test_staffing_excel_general_and_department_sheets() -> None:
    departments = [
        DepartmentOut(
            id=10,
            name="Платформа",
            sortOrder=1,
            isActive=True,
            memberCount=2,
        ),
        DepartmentOut(
            id=20,
            name="Пустой отдел",
            sortOrder=2,
            isActive=True,
            memberCount=0,
        ),
        DepartmentOut(
            id=30,
            name="Аналитика",
            sortOrder=0,
            isActive=True,
            memberCount=1,
        ),
    ]
    employees = [
        _employee(
            emp_id=1,
            name="Белов Борис",
            departments=[EmployeeDepartmentBriefOut(departmentId=10, departmentName="Платформа")],
        ),
        _employee(
            emp_id=2,
            name="Алова Анна",
            departments=[
                EmployeeDepartmentBriefOut(departmentId=10, departmentName="Платформа"),
                EmployeeDepartmentBriefOut(departmentId=30, departmentName="Аналитика"),
            ],
            is_org_head=True,
        ),
        _employee(
            emp_id=3,
            name="Сидоров Сидор",
            departments=[],
        ),
    ]

    content, filename = generate_staffing_excel(employees, departments)
    assert filename.endswith(".xlsx")

    workbook = load_workbook(filename=io.BytesIO(content))
    assert workbook.sheetnames == ["Общий список", "Аналитика", "Платформа"]

    general = workbook["Общий список"]
    assert general.cell(1, 1).value == "ФИО"
    assert general.cell(1, 9).value == "Директор организации"
    assert general.cell(2, 1).value == "Алова Анна"
    assert general.cell(2, 9).value == "Да"
    assert general.cell(3, 1).value == "Белов Борис"
    assert general.cell(3, 9).value == "Нет"
    assert general.max_row == 3

    analytics = workbook["Аналитика"]
    assert analytics.cell(2, 1).value == "Алова Анна"
    assert analytics.max_row == 2

    platform = workbook["Платформа"]
    assert platform.cell(2, 1).value == "Алова Анна"
    assert platform.cell(3, 1).value == "Белов Борис"
    assert platform.max_row == 3
