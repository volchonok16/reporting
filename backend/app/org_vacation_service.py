from __future__ import annotations

from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.org_models import Department, DepartmentMember, Employee, EmployeeTimeOffDay, WorkspaceBooking
from app.org_photo_service import photo_public_url
from app.org_service import get_employee_for_org_user
from app.org_schemas import (
    VacationEmployeeOut,
    VacationRangeIn,
    VacationRangeOut,
    VacationScheduleOut,
    VacationTimeOffDayOut,
)

EDITABLE_KINDS = frozenset({"vacation", "dayoff", "sick_leave", "business_trip"})
ABSENCE_KINDS = frozenset({"vacation", "dayoff", "sick_leave", "business_trip"})


def _parse_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректная дата.") from exc


def _year_bounds(year: int) -> tuple[date, date]:
    return date(year, 1, 1), date(year, 12, 31)


def _actor_employee_id(db: Session, meta: dict) -> int | None:
    org_user_id = meta.get("org_user_id")
    if not org_user_id:
        return None
    emp = get_employee_for_org_user(db, int(org_user_id))
    return emp.id if emp else None


def _is_org_admin(meta: dict) -> bool:
    auth_mode = meta.get("auth_mode")
    app_role = meta.get("app_role")
    org_user_role = meta.get("org_user_role")
    return (
        auth_mode == "pat"
        or (auth_mode == "app_user" and app_role == "full" and org_user_role is None)
        or org_user_role == "admin"
    )


def can_edit_employee_vacation(
    meta: dict,
    actor_employee_id: int | None,
    target_employee_id: int,
) -> bool:
    if _is_org_admin(meta):
        return True
    if actor_employee_id is None:
        return False
    return actor_employee_id == target_employee_id


def _load_employees(db: Session, department_id: int | None) -> list[Employee]:
    stmt = select(Employee).where(Employee.is_active.is_(True)).order_by(Employee.full_name)
    if department_id is not None:
        stmt = (
            select(Employee)
            .join(DepartmentMember, DepartmentMember.employee_id == Employee.id)
            .where(
                DepartmentMember.department_id == department_id,
                Employee.is_active.is_(True),
            )
            .order_by(DepartmentMember.sort_order, Employee.full_name)
        )
    return list(db.scalars(stmt).unique().all())


def _load_primary_department_names(db: Session, employee_ids: list[int]) -> dict[int, str]:
    if not employee_ids:
        return {}
    rows = db.execute(
        select(
            DepartmentMember.employee_id,
            Department.name,
        )
        .join(Department, Department.id == DepartmentMember.department_id)
        .where(DepartmentMember.employee_id.in_(employee_ids))
        .order_by(DepartmentMember.employee_id, DepartmentMember.sort_order, DepartmentMember.id)
    ).all()
    names: dict[int, str] = {}
    for employee_id, department_name in rows:
        if employee_id not in names and department_name:
            names[employee_id] = department_name
    return names


def get_vacation_schedule(
    db: Session,
    *,
    year: int,
    department_id: int | None,
    meta: dict,
) -> VacationScheduleOut:
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Некорректный год.")

    employees = _load_employees(db, department_id)
    employee_ids = [emp.id for emp in employees]
    department_names = _load_primary_department_names(db, employee_ids)
    actor_employee_id = _actor_employee_id(db, meta)
    day_from, day_to = _year_bounds(year)

    days_out: list[VacationTimeOffDayOut] = []
    if employee_ids:
        rows = db.scalars(
            select(EmployeeTimeOffDay)
            .where(
                EmployeeTimeOffDay.employee_id.in_(employee_ids),
                EmployeeTimeOffDay.day >= day_from,
                EmployeeTimeOffDay.day <= day_to,
            )
            .order_by(EmployeeTimeOffDay.day)
        ).all()
        days_out = [
            VacationTimeOffDayOut(
                employeeId=row.employee_id,
                day=row.day.isoformat(),
                kind=row.kind,  # type: ignore[arg-type]
            )
            for row in rows
        ]

    employee_out = [
        VacationEmployeeOut(
            id=emp.id,
            fullName=emp.full_name,
            departmentName=department_names.get(emp.id),
            position=emp.position,
            managerId=emp.manager_id,
            photoUrl=photo_public_url(emp.photo_path),
            canEdit=can_edit_employee_vacation(meta, actor_employee_id, emp.id),
            isSelf=actor_employee_id == emp.id,
        )
        for emp in employees
    ]

    return VacationScheduleOut(
        year=year,
        departmentId=department_id,
        actorEmployeeId=actor_employee_id,
        employees=employee_out,
        timeOffDays=days_out,
    )


def upsert_vacation_range(db: Session, data: VacationRangeIn, meta: dict) -> VacationRangeOut:
    employee = db.get(Employee, data.employeeId)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")

    actor_employee_id = _actor_employee_id(db, meta)
    if not can_edit_employee_vacation(meta, actor_employee_id, data.employeeId):
        raise HTTPException(status_code=403, detail="Недостаточно прав для редактирования графика.")

    start = _parse_day(data.fromDay)
    end = _parse_day(data.toDay)
    if start > end:
        start, end = end, start

    if data.kind != "erase" and data.kind not in EDITABLE_KINDS:
        raise HTTPException(status_code=400, detail="Недопустимый тип отсутствия.")

    affected = 0
    if data.kind == "erase":
        result = db.execute(
            delete(EmployeeTimeOffDay).where(
                EmployeeTimeOffDay.employee_id == data.employeeId,
                EmployeeTimeOffDay.day >= start,
                EmployeeTimeOffDay.day <= end,
                EmployeeTimeOffDay.kind.in_(tuple(EDITABLE_KINDS)),
            )
        )
        affected = result.rowcount or 0
    else:
        cursor = start
        while cursor <= end:
            existing = db.scalar(
                select(EmployeeTimeOffDay).where(
                    EmployeeTimeOffDay.employee_id == data.employeeId,
                    EmployeeTimeOffDay.day == cursor,
                )
            )
            if existing is None:
                db.add(
                    EmployeeTimeOffDay(
                        employee_id=data.employeeId,
                        day=cursor,
                        kind=data.kind,
                    )
                )
                affected += 1
            elif existing.kind != data.kind:
                existing.kind = data.kind
                affected += 1
            cursor += timedelta(days=1)

        # Employee cannot keep a workspace booking on absence days.
        if data.kind in ABSENCE_KINDS:
            db.execute(
                delete(WorkspaceBooking).where(
                    WorkspaceBooking.employee_id == data.employeeId,
                    WorkspaceBooking.day >= start,
                    WorkspaceBooking.day <= end,
                )
            )

    db.commit()
    return VacationRangeOut(affectedDays=affected)
