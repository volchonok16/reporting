from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, joinedload

from app.org_models import DepartmentMember, Employee, EmployeeExpertise, EmployeeTimeOffDay, OrgUser
from app.org_service import get_employee_for_org_user
from app.planning_calendar import default_is_working_day, is_ru_public_holiday, iter_days
from app.planning_models import (
    BOOKING_MODE_DAILY,
    BOOKING_MODE_PERIOD,
    PROJECT_STATUS_COMPLETED,
    PROJECT_STATUSES,
    PlanningAllocation,
    PlanningAllocationDay,
    PlanningCustomerDepartment,
    PlanningProject,
    PlanningProjectComplexity,
    PlanningProjectExecutor,
    ProductionCalendarDay,
)
from app.planning_schemas import (
    PlanningAllocationDayIn,
    PlanningAllocationDayOut,
    PlanningAllocationIn,
    PlanningAllocationOut,
    PlanningAllocationUpdateIn,
    PlanningComplexityIn,
    PlanningComplexityOut,
    PlanningCustomerDepartmentIn,
    PlanningCustomerDepartmentOut,
    PlanningCustomerDepartmentUpdateIn,
    PlanningExecutorOut,
    PlanningProjectIn,
    PlanningProjectOut,
    PlanningProjectUpdateIn,
    PlanningWorkloadAllocationCell,
    PlanningWorkloadDayCell,
    PlanningWorkloadEmployeeOut,
    PlanningWorkloadOut,
    ProductionCalendarDayIn,
    ProductionCalendarDayOut,
)


def _decimal(value: Decimal | float | int | None) -> Decimal:
    if value is None:
        return Decimal("0")
    return Decimal(str(value))


def _created_by_label(db: Session, meta: dict) -> tuple[int | None, str | None]:
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    app_login = meta.get("app_login")
    label = app_login
    if org_user_id:
        user = db.get(OrgUser, org_user_id)
        if user:
            label = user.email
        emp = get_employee_for_org_user(db, org_user_id)
        if emp:
            label = emp.full_name
    return org_user_id, label


def _expertise_labels(employee: Employee) -> list[str]:
    labels: list[str] = []
    for item in employee.expertises:
        if item.direction is None:
            continue
        labels.append(item.direction.name + (f" ({item.level})" if item.level else ""))
    return labels


def _department_names(employee: Employee) -> list[str]:
    names: list[str] = []
    for member in employee.department_members:
        if member.department and member.department.name not in names:
            names.append(member.department.name)
    return names


def is_working_day(db: Session, day: date) -> bool:
    row = db.get(ProductionCalendarDay, day)
    if row is not None:
        return row.is_working_day
    return default_is_working_day(day)


def _employee_time_off_days(db: Session, employee_id: int, start: date, end: date) -> set[date]:
    if start > end:
        return set()
    rows = db.scalars(
        select(EmployeeTimeOffDay.day).where(
            EmployeeTimeOffDay.employee_id == employee_id,
            EmployeeTimeOffDay.day >= start,
            EmployeeTimeOffDay.day <= end,
        )
    ).all()
    return set(rows)


def list_complexities(db: Session) -> list[PlanningComplexityOut]:
    rows = db.scalars(
        select(PlanningProjectComplexity).order_by(PlanningProjectComplexity.sort_order, PlanningProjectComplexity.id)
    ).all()
    return [
        PlanningComplexityOut(id=r.id, name=r.name, sortOrder=r.sort_order, isActive=r.is_active)
        for r in rows
    ]


def create_complexity(db: Session, data: PlanningComplexityIn) -> PlanningComplexityOut:
    row = PlanningProjectComplexity(name=data.name.strip(), sort_order=data.sortOrder, is_active=data.isActive)
    db.add(row)
    db.commit()
    db.refresh(row)
    return PlanningComplexityOut(id=row.id, name=row.name, sortOrder=row.sort_order, isActive=row.is_active)


def _customer_department_out(row: PlanningCustomerDepartment) -> PlanningCustomerDepartmentOut:
    return PlanningCustomerDepartmentOut(
        id=row.id, name=row.name, sortOrder=row.sort_order, isActive=row.is_active
    )


def list_customer_departments(db: Session, *, active_only: bool = False) -> list[PlanningCustomerDepartmentOut]:
    query = select(PlanningCustomerDepartment).order_by(
        PlanningCustomerDepartment.sort_order, PlanningCustomerDepartment.name, PlanningCustomerDepartment.id
    )
    if active_only:
        query = query.where(PlanningCustomerDepartment.is_active.is_(True))
    return [_customer_department_out(row) for row in db.scalars(query).all()]


def create_customer_department(db: Session, data: PlanningCustomerDepartmentIn) -> PlanningCustomerDepartmentOut:
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Укажите название департамента заказчика")
    existing = db.scalar(
        select(PlanningCustomerDepartment).where(func.lower(PlanningCustomerDepartment.name) == name.lower())
    )
    if existing is not None:
        raise HTTPException(status_code=400, detail="Такой департамент заказчика уже есть")
    row = PlanningCustomerDepartment(name=name, sort_order=data.sortOrder, is_active=data.isActive)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _customer_department_out(row)


def update_customer_department(
    db: Session, department_id: int, data: PlanningCustomerDepartmentUpdateIn
) -> PlanningCustomerDepartmentOut:
    row = db.get(PlanningCustomerDepartment, department_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Департамент заказчика не найден")
    patch = data.model_dump(exclude_unset=True)
    if "name" in patch:
        name = str(patch["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Укажите название департамента заказчика")
        dup = db.scalar(
            select(PlanningCustomerDepartment).where(
                func.lower(PlanningCustomerDepartment.name) == name.lower(),
                PlanningCustomerDepartment.id != department_id,
            )
        )
        if dup is not None:
            raise HTTPException(status_code=400, detail="Такой департамент заказчика уже есть")
        row.name = name
    if "sortOrder" in patch and patch["sortOrder"] is not None:
        row.sort_order = int(patch["sortOrder"])
    if "isActive" in patch and patch["isActive"] is not None:
        row.is_active = bool(patch["isActive"])
    db.commit()
    db.refresh(row)
    return _customer_department_out(row)


def delete_customer_department(db: Session, department_id: int) -> None:
    row = db.get(PlanningCustomerDepartment, department_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Департамент заказчика не найден")
    db.delete(row)
    db.commit()


def _ensure_customer_department(db: Session, department_id: int | None) -> None:
    if department_id is None:
        return
    if db.get(PlanningCustomerDepartment, department_id) is None:
        raise HTTPException(status_code=400, detail="Департамент заказчика не найден")


def _project_hours(db: Session, project_id: int) -> tuple[Decimal, Decimal]:
    planned, actual = db.execute(
        select(
            func.coalesce(func.sum(PlanningAllocationDay.planned_hours), 0),
            func.coalesce(func.sum(PlanningAllocationDay.actual_hours), 0),
        )
        .join(PlanningAllocation, PlanningAllocation.id == PlanningAllocationDay.allocation_id)
        .where(PlanningAllocation.project_id == project_id)
    ).one()
    return _decimal(planned), _decimal(actual)


def _resolve_executor_ids(executor_ids: list[int] | None, legacy_id: int | None = None) -> list[int]:
    result: list[int] = []
    seen: set[int] = set()
    for employee_id in executor_ids or []:
        if employee_id in seen:
            continue
        seen.add(employee_id)
        result.append(employee_id)
    if legacy_id is not None and legacy_id not in seen:
        result.append(legacy_id)
    return result


def _allocation_executor_ids(db: Session, project_id: int) -> set[int]:
    rows = db.execute(
        select(PlanningAllocation.employee_id)
        .join(PlanningAllocationDay, PlanningAllocationDay.allocation_id == PlanningAllocation.id)
        .where(PlanningAllocation.project_id == project_id)
        .group_by(PlanningAllocation.employee_id)
        .having(func.coalesce(func.sum(PlanningAllocationDay.planned_hours), 0) > 0)
    ).all()
    return {int(row[0]) for row in rows}


def _set_project_executors(db: Session, project_id: int, employee_ids: list[int]) -> None:
    db.execute(delete(PlanningProjectExecutor).where(PlanningProjectExecutor.project_id == project_id))
    for employee_id in _resolve_executor_ids(employee_ids):
        if db.get(Employee, employee_id) is None:
            raise HTTPException(status_code=400, detail=f"Сотрудник {employee_id} не найден")
        db.add(PlanningProjectExecutor(project_id=project_id, employee_id=employee_id))


def _persist_executors_from_allocations(db: Session, project_id: int) -> None:
    for employee_id in _allocation_executor_ids(db, project_id):
        exists = db.scalar(
            select(PlanningProjectExecutor.id).where(
                PlanningProjectExecutor.project_id == project_id,
                PlanningProjectExecutor.employee_id == employee_id,
            )
        )
        if exists is None:
            db.add(PlanningProjectExecutor(project_id=project_id, employee_id=employee_id))


def _project_executors_out(db: Session, project_id: int) -> tuple[list[int], list[PlanningExecutorOut]]:
    allocation_ids = _allocation_executor_ids(db, project_id)
    stored = db.scalars(
        select(PlanningProjectExecutor)
        .options(joinedload(PlanningProjectExecutor.employee))
        .where(PlanningProjectExecutor.project_id == project_id)
    ).unique().all()
    by_id: dict[int, PlanningExecutorOut] = {}
    for row in stored:
        by_id[row.employee_id] = PlanningExecutorOut(
            id=row.employee_id,
            fullName=row.employee.full_name,
            fromAllocation=row.employee_id in allocation_ids,
        )
    missing = allocation_ids - set(by_id)
    if missing:
        for employee in db.scalars(select(Employee).where(Employee.id.in_(missing))).all():
            by_id[employee.id] = PlanningExecutorOut(
                id=employee.id,
                fullName=employee.full_name,
                fromAllocation=True,
            )
    ordered = sorted(by_id.values(), key=lambda item: item.fullName.casefold())
    return [item.id for item in ordered], ordered


def _resolve_project_status(status: str | None, actual_end_date: date | None) -> str:
    if actual_end_date is not None:
        return PROJECT_STATUS_COMPLETED
    if status in PROJECT_STATUSES:
        return status
    return "new"


def _clear_allocations_after_completion(db: Session, project: PlanningProject) -> None:
    """После даты завершения (факт) обнуляет выделенное время по проекту."""
    if project.status != PROJECT_STATUS_COMPLETED or project.actual_end_date is None:
        return
    cutoff = project.actual_end_date
    allocations = list(
        db.scalars(
            select(PlanningAllocation)
            .options(joinedload(PlanningAllocation.days))
            .where(PlanningAllocation.project_id == project.id)
        ).unique().all()
    )
    for allocation in allocations:
        db.execute(
            delete(PlanningAllocationDay).where(
                PlanningAllocationDay.allocation_id == allocation.id,
                PlanningAllocationDay.day > cutoff,
            )
        )
        if allocation.allocation_start_date > cutoff:
            db.delete(allocation)
            continue
        if allocation.allocation_end_date > cutoff:
            allocation.allocation_end_date = cutoff


def _project_completion_cutoff(db: Session, project_id: int) -> date | None:
    project = db.get(PlanningProject, project_id)
    if project is None:
        return None
    if project.status == PROJECT_STATUS_COMPLETED and project.actual_end_date is not None:
        return project.actual_end_date
    return None


def _project_out(db: Session, project: PlanningProject) -> PlanningProjectOut:
    allocation_count = db.scalar(
        select(func.count()).select_from(PlanningAllocation).where(PlanningAllocation.project_id == project.id)
    )
    total_planned, total_actual = _project_hours(db, project.id)
    executor_ids, executors = _project_executors_out(db, project.id)
    first_executor = executors[0] if executors else None
    return PlanningProjectOut(
        id=project.id,
        requestNumber=project.request_number,
        requestName=project.request_name,
        requestUrl=project.request_url,
        complexityId=project.complexity_id,
        complexityName=project.complexity.name if project.complexity else None,
        executorIds=executor_ids,
        executors=executors,
        customerEmployeeId=first_executor.id if first_executor else project.customer_employee_id,
        customerEmployeeName=first_executor.fullName if first_executor else (
            project.customer_employee.full_name if project.customer_employee else None
        ),
        customerName=project.customer_name,
        customerDepartmentId=project.customer_department_id,
        customerDepartmentName=project.customer_department.name if project.customer_department else None,
        plannedStartDate=project.planned_start_date,
        actualStartDate=project.actual_start_date,
        plannedEndDate=project.planned_end_date,
        actualEndDate=project.actual_end_date,
        status=_resolve_project_status(project.status, project.actual_end_date),
        notes=project.notes,
        createdByLabel=project.created_by_label,
        createdAt=project.created_at.date() if project.created_at else None,
        allocationCount=int(allocation_count or 0),
        totalPlannedHours=total_planned,
        totalActualHours=total_actual,
    )


def list_projects(db: Session) -> list[PlanningProjectOut]:
    rows = db.scalars(
        select(PlanningProject)
        .options(
            joinedload(PlanningProject.complexity),
            joinedload(PlanningProject.customer_employee),
            joinedload(PlanningProject.customer_department),
        )
        .order_by(PlanningProject.planned_start_date.desc().nullslast(), PlanningProject.id.desc())
    ).unique().all()
    return [_project_out(db, row) for row in rows]


def get_project(db: Session, project_id: int) -> PlanningProjectOut:
    project = db.scalars(
        select(PlanningProject)
        .options(
            joinedload(PlanningProject.complexity),
            joinedload(PlanningProject.customer_employee),
            joinedload(PlanningProject.customer_department),
        )
        .where(PlanningProject.id == project_id)
    ).unique().one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return _project_out(db, project)


def create_project(db: Session, data: PlanningProjectIn, meta: dict) -> PlanningProjectOut:
    org_user_id, label = _created_by_label(db, meta)
    _ensure_customer_department(db, data.customerDepartmentId)
    project = PlanningProject(
        request_number=data.requestNumber.strip(),
        request_name=data.requestName.strip(),
        request_url=data.requestUrl.strip() if data.requestUrl else None,
        complexity_id=data.complexityId,
        customer_employee_id=data.customerEmployeeId,
        customer_name=data.customerName.strip() if data.customerName else None,
        customer_department_id=data.customerDepartmentId,
        planned_start_date=data.plannedStartDate,
        actual_start_date=data.actualStartDate,
        planned_end_date=data.plannedEndDate,
        actual_end_date=data.actualEndDate,
        status=_resolve_project_status(data.status, data.actualEndDate),
        notes=data.notes,
        created_by_org_user_id=org_user_id,
        created_by_label=label,
    )
    db.add(project)
    db.flush()
    _set_project_executors(db, project.id, _resolve_executor_ids(data.executorIds, data.customerEmployeeId))
    db.commit()
    return get_project(db, project.id)


def update_project(db: Session, project_id: int, data: PlanningProjectUpdateIn) -> PlanningProjectOut:
    project = db.get(PlanningProject, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    patch = data.model_dump(exclude_unset=True)
    if "customerDepartmentId" in patch:
        _ensure_customer_department(db, patch["customerDepartmentId"])
    field_map = {
        "requestNumber": "request_number",
        "requestName": "request_name",
        "requestUrl": "request_url",
        "complexityId": "complexity_id",
        "customerEmployeeId": "customer_employee_id",
        "customerName": "customer_name",
        "customerDepartmentId": "customer_department_id",
        "plannedStartDate": "planned_start_date",
        "actualStartDate": "actual_start_date",
        "plannedEndDate": "planned_end_date",
        "actualEndDate": "actual_end_date",
        "status": "status",
        "notes": "notes",
    }
    for api_field, db_field in field_map.items():
        if api_field not in patch:
            continue
        value = patch[api_field]
        if api_field in {"requestNumber", "requestName"} and value is not None:
            value = str(value).strip()
        if api_field in {"requestUrl", "customerName", "notes"} and isinstance(value, str):
            value = value.strip() or None
        setattr(project, db_field, value)
    if "actualEndDate" in patch or "status" in patch:
        project.status = _resolve_project_status(project.status, project.actual_end_date)
    elif project.actual_end_date is not None and project.status != PROJECT_STATUS_COMPLETED:
        project.status = PROJECT_STATUS_COMPLETED
    if "executorIds" in patch:
        _set_project_executors(db, project_id, _resolve_executor_ids(patch["executorIds"], patch.get("customerEmployeeId")))
    elif "customerEmployeeId" in patch and patch["customerEmployeeId"] is not None:
        _set_project_executors(db, project_id, [int(patch["customerEmployeeId"])])
    _clear_allocations_after_completion(db, project)
    db.commit()
    return get_project(db, project_id)


def delete_project(db: Session, project_id: int) -> None:
    project = db.get(PlanningProject, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    db.delete(project)
    db.commit()


def _allocation_out(allocation: PlanningAllocation) -> PlanningAllocationOut:
    total_planned = sum((_decimal(day.planned_hours) for day in allocation.days), Decimal("0"))
    total_actual = sum((_decimal(day.actual_hours) for day in allocation.days), Decimal("0"))
    return PlanningAllocationOut(
        id=allocation.id,
        projectId=allocation.project_id,
        employeeId=allocation.employee_id,
        employeeName=allocation.employee.full_name,
        employeeExpertises=_expertise_labels(allocation.employee),
        allocationStartDate=allocation.allocation_start_date,
        allocationEndDate=allocation.allocation_end_date,
        bookingMode=allocation.booking_mode,
        plannedHoursPerDay=_decimal(allocation.planned_hours_per_day) if allocation.planned_hours_per_day else None,
        createdByLabel=allocation.created_by_label,
        totalPlannedHours=total_planned,
        totalActualHours=total_actual,
        days=[
            PlanningAllocationDayOut(
                day=day.day,
                plannedHours=_decimal(day.planned_hours),
                actualHours=_decimal(day.actual_hours),
            )
            for day in sorted(allocation.days, key=lambda item: item.day)
        ],
    )


def _generate_period_days(
    db: Session,
    allocation: PlanningAllocation,
    hours_per_day: Decimal,
    preserve_actual: dict[date, Decimal] | None = None,
) -> list[PlanningAllocationDay]:
    preserve_actual = preserve_actual or {}
    time_off_days = _employee_time_off_days(
        db,
        allocation.employee_id,
        allocation.allocation_start_date,
        allocation.allocation_end_date,
    )
    rows: list[PlanningAllocationDay] = []
    for day in iter_days(allocation.allocation_start_date, allocation.allocation_end_date):
        if day in time_off_days or not is_working_day(db, day):
            continue
        rows.append(
            PlanningAllocationDay(
                allocation_id=allocation.id,
                day=day,
                planned_hours=hours_per_day,
                actual_hours=preserve_actual.get(day, Decimal("0")),
            )
        )
    return rows


def _employee_planned_hours_by_day(
    db: Session,
    employee_id: int,
    start: date,
    end: date,
) -> dict[date, Decimal]:
    if start > end:
        return {}
    rows = db.execute(
        select(
            PlanningAllocationDay.day,
            func.coalesce(func.sum(PlanningAllocationDay.planned_hours), 0),
        )
        .join(PlanningAllocation, PlanningAllocation.id == PlanningAllocationDay.allocation_id)
        .where(
            PlanningAllocation.employee_id == employee_id,
            PlanningAllocationDay.day >= start,
            PlanningAllocationDay.day <= end,
        )
        .group_by(PlanningAllocationDay.day)
    ).all()
    return {day: _decimal(total) for day, total in rows}


def _assert_employee_capacity(
    db: Session,
    employee_id: int,
    proposed_days: list[tuple[date, Decimal]],
) -> None:
    """Запрещает выделение, если план по всем проектам превысит дневную ёмкость сотрудника."""
    positives = [(day, hours) for day, hours in proposed_days if hours > 0]
    if not positives:
        return
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(status_code=400, detail="Сотрудник не найден")
    capacity = _decimal(employee.daily_work_hours)
    start = min(day for day, _ in positives)
    end = max(day for day, _ in positives)
    existing = _employee_planned_hours_by_day(db, employee_id, start, end)
    time_off = _employee_time_off_days(db, employee_id, start, end)
    conflicts: list[str] = []
    for day, hours in positives:
        if day in time_off or not is_working_day(db, day):
            continue
        already = existing.get(day, Decimal("0"))
        total = already + hours
        if total <= capacity:
            continue
        available = capacity - already
        if available < 0:
            available = Decimal("0")
        conflicts.append(
            f"{day.isoformat()}: нужно {hours} ч, доступно {available} ч "
            f"(норма {capacity} ч, уже занято {already} ч)"
        )
    if not conflicts:
        return
    shown = conflicts[:8]
    detail = "Превышена доступная загрузка сотрудника. " + "; ".join(shown)
    if len(conflicts) > 8:
        detail += f" и ещё {len(conflicts) - 8} дн."
    raise HTTPException(status_code=400, detail=detail)


def _proposed_days_period(
    db: Session,
    employee_id: int,
    start: date,
    end: date,
    hours_per_day: Decimal,
) -> list[tuple[date, Decimal]]:
    time_off_days = _employee_time_off_days(db, employee_id, start, end)
    result: list[tuple[date, Decimal]] = []
    for day in iter_days(start, end):
        if day in time_off_days or not is_working_day(db, day):
            continue
        if hours_per_day > 0:
            result.append((day, hours_per_day))
    return result


def _proposed_days_daily(
    db: Session,
    employee_id: int,
    start: date,
    end: date,
    day_items: list[PlanningAllocationDayIn],
) -> list[tuple[date, Decimal]]:
    time_off_days = _employee_time_off_days(db, employee_id, start, end)
    result: list[tuple[date, Decimal]] = []
    for item in day_items:
        if item.day < start or item.day > end:
            continue
        if item.day in time_off_days or not is_working_day(db, item.day):
            continue
        planned = _decimal(item.plannedHours)
        if planned > 0:
            result.append((item.day, planned))
    return result


def _apply_allocation_days(
    db: Session,
    allocation: PlanningAllocation,
    booking_mode: str,
    planned_hours_per_day: Decimal | None,
    day_items: list[PlanningAllocationDayIn],
) -> None:
    db.execute(delete(PlanningAllocationDay).where(PlanningAllocationDay.allocation_id == allocation.id))
    preserve_actual = {item.day: _decimal(item.actualHours) for item in day_items if _decimal(item.actualHours) > 0}

    if booking_mode == BOOKING_MODE_PERIOD:
        hours = _decimal(planned_hours_per_day)
        allocation.planned_hours_per_day = hours
        proposed = _proposed_days_period(
            db,
            allocation.employee_id,
            allocation.allocation_start_date,
            allocation.allocation_end_date,
            hours,
        )
        _assert_employee_capacity(db, allocation.employee_id, proposed)
        for row in _generate_period_days(db, allocation, hours, preserve_actual):
            db.add(row)
        return

    allocation.planned_hours_per_day = None
    proposed = _proposed_days_daily(
        db,
        allocation.employee_id,
        allocation.allocation_start_date,
        allocation.allocation_end_date,
        day_items,
    )
    _assert_employee_capacity(db, allocation.employee_id, proposed)
    time_off_days = _employee_time_off_days(
        db,
        allocation.employee_id,
        allocation.allocation_start_date,
        allocation.allocation_end_date,
    )
    for item in day_items:
        if item.day in time_off_days or not is_working_day(db, item.day):
            continue
        planned = _decimal(item.plannedHours)
        actual = _decimal(item.actualHours)
        if planned <= 0 and actual <= 0:
            continue
        db.add(
            PlanningAllocationDay(
                allocation_id=allocation.id,
                day=item.day,
                planned_hours=planned,
                actual_hours=actual,
            )
        )


def list_allocations(db: Session, project_id: int) -> list[PlanningAllocationOut]:
    if db.get(PlanningProject, project_id) is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    rows = db.scalars(
        select(PlanningAllocation)
        .options(
            joinedload(PlanningAllocation.employee).joinedload(Employee.expertises).joinedload(EmployeeExpertise.direction),
            joinedload(PlanningAllocation.days),
        )
        .where(PlanningAllocation.project_id == project_id)
        .order_by(PlanningAllocation.allocation_start_date, PlanningAllocation.id)
    ).unique().all()
    return [_allocation_out(row) for row in rows]


def _get_allocation(db: Session, allocation_id: int) -> PlanningAllocation:
    allocation = db.scalars(
        select(PlanningAllocation)
        .options(
            joinedload(PlanningAllocation.employee).joinedload(Employee.expertises).joinedload(EmployeeExpertise.direction),
            joinedload(PlanningAllocation.days),
        )
        .where(PlanningAllocation.id == allocation_id)
    ).unique().one_or_none()
    if allocation is None:
        raise HTTPException(status_code=404, detail="Выделение не найдено")
    return allocation


def create_allocation(db: Session, project_id: int, data: PlanningAllocationIn, meta: dict) -> PlanningAllocationOut:
    if db.get(PlanningProject, project_id) is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if db.get(Employee, data.employeeId) is None:
        raise HTTPException(status_code=400, detail="Сотрудник не найден")
    if data.allocationEndDate < data.allocationStartDate:
        raise HTTPException(status_code=400, detail="Дата окончания раньше даты начала")
    cutoff = _project_completion_cutoff(db, project_id)
    start_date = data.allocationStartDate
    end_date = data.allocationEndDate
    if cutoff is not None:
        if start_date > cutoff:
            raise HTTPException(
                status_code=400,
                detail=f"Проект завершён {cutoff.isoformat()}: нельзя выделять ресурсы после даты завершения",
            )
        if end_date > cutoff:
            end_date = cutoff
    booking_mode = data.bookingMode if data.bookingMode in (BOOKING_MODE_DAILY, BOOKING_MODE_PERIOD) else BOOKING_MODE_PERIOD
    org_user_id, label = _created_by_label(db, meta)
    allocation = PlanningAllocation(
        project_id=project_id,
        employee_id=data.employeeId,
        allocation_start_date=start_date,
        allocation_end_date=end_date,
        booking_mode=booking_mode,
        planned_hours_per_day=_decimal(data.plannedHoursPerDay) if data.plannedHoursPerDay is not None else None,
        created_by_org_user_id=org_user_id,
        created_by_label=label,
    )
    db.add(allocation)
    db.flush()
    day_items = data.days
    if cutoff is not None:
        day_items = [item for item in data.days if item.day <= cutoff]
    _apply_allocation_days(db, allocation, booking_mode, data.plannedHoursPerDay, day_items)
    _persist_executors_from_allocations(db, project_id)
    db.commit()
    return _allocation_out(_get_allocation(db, allocation.id))


def update_allocation(db: Session, allocation_id: int, data: PlanningAllocationUpdateIn) -> PlanningAllocationOut:
    allocation = db.scalars(
        select(PlanningAllocation)
        .options(joinedload(PlanningAllocation.days))
        .where(PlanningAllocation.id == allocation_id)
    ).unique().one_or_none()
    if allocation is None:
        raise HTTPException(status_code=404, detail="Выделение не найдено")
    if data.employeeId is not None:
        if db.get(Employee, data.employeeId) is None:
            raise HTTPException(status_code=400, detail="Сотрудник не найден")
        allocation.employee_id = data.employeeId
    if data.allocationStartDate is not None:
        allocation.allocation_start_date = data.allocationStartDate
    if data.allocationEndDate is not None:
        allocation.allocation_end_date = data.allocationEndDate
    cutoff = _project_completion_cutoff(db, allocation.project_id)
    if cutoff is not None:
        if allocation.allocation_start_date > cutoff:
            raise HTTPException(
                status_code=400,
                detail=f"Проект завершён {cutoff.isoformat()}: нельзя выделять ресурсы после даты завершения",
            )
        if allocation.allocation_end_date > cutoff:
            allocation.allocation_end_date = cutoff
    if allocation.allocation_end_date < allocation.allocation_start_date:
        raise HTTPException(status_code=400, detail="Дата окончания раньше даты начала")
    booking_mode = data.bookingMode or allocation.booking_mode
    allocation.booking_mode = booking_mode
    day_items = data.days if data.days is not None else [
        PlanningAllocationDayIn(day=day.day, plannedHours=day.planned_hours, actualHours=day.actual_hours)
        for day in allocation.days
    ]
    if cutoff is not None:
        day_items = [item for item in day_items if item.day <= cutoff]
    _apply_allocation_days(
        db,
        allocation,
        booking_mode,
        data.plannedHoursPerDay if data.plannedHoursPerDay is not None else allocation.planned_hours_per_day,
        day_items,
    )
    _persist_executors_from_allocations(db, allocation.project_id)
    db.commit()
    return _allocation_out(_get_allocation(db, allocation_id))


def delete_allocation(db: Session, allocation_id: int) -> None:
    allocation = db.get(PlanningAllocation, allocation_id)
    if allocation is None:
        raise HTTPException(status_code=404, detail="Выделение не найдено")
    project_id = allocation.project_id
    db.delete(allocation)
    db.flush()
    _persist_executors_from_allocations(db, project_id)
    db.commit()


def update_allocation_days(db: Session, allocation_id: int, days: list[PlanningAllocationDayIn]) -> PlanningAllocationOut:
    allocation = db.scalars(
        select(PlanningAllocation)
        .options(joinedload(PlanningAllocation.days))
        .where(PlanningAllocation.id == allocation_id)
    ).unique().one_or_none()
    if allocation is None:
        raise HTTPException(status_code=404, detail="Выделение не найдено")
    if allocation.booking_mode != BOOKING_MODE_DAILY:
        raise HTTPException(status_code=400, detail="Подневное редактирование доступно только в режиме daily")
    _apply_allocation_days(db, allocation, BOOKING_MODE_DAILY, None, days)
    _persist_executors_from_allocations(db, allocation.project_id)
    db.commit()
    return _allocation_out(_get_allocation(db, allocation_id))


def list_calendar_days(db: Session, year: int) -> list[ProductionCalendarDayOut]:
    start = date(year, 1, 1)
    end = date(year, 12, 31)
    overrides = {
        row.day: row
        for row in db.scalars(
            select(ProductionCalendarDay).where(ProductionCalendarDay.day >= start, ProductionCalendarDay.day <= end)
        ).all()
    }
    result: list[ProductionCalendarDayOut] = []
    for day in iter_days(start, end):
        override = overrides.get(day)
        if override is not None:
            result.append(
                ProductionCalendarDayOut(
                    day=override.day,
                    isWorkingDay=override.is_working_day,
                    title=override.title,
                    note=override.note,
                )
            )
            continue
        if not default_is_working_day(day):
            title = "Выходной" if day.weekday() >= 5 else "Праздник РФ"
            if is_ru_public_holiday(day):
                title = "Праздник РФ"
            result.append(ProductionCalendarDayOut(day=day, isWorkingDay=False, title=title))
    return result


def upsert_calendar_days(db: Session, days: list[ProductionCalendarDayIn]) -> list[ProductionCalendarDayOut]:
    saved: list[ProductionCalendarDayOut] = []
    for item in days:
        row = db.get(ProductionCalendarDay, item.day)
        if row is None:
            row = ProductionCalendarDay(day=item.day, is_working_day=item.isWorkingDay, title=item.title, note=item.note)
            db.add(row)
        else:
            row.is_working_day = item.isWorkingDay
            row.title = item.title
            row.note = item.note
        saved.append(
            ProductionCalendarDayOut(day=row.day, isWorkingDay=row.is_working_day, title=row.title, note=row.note)
        )
    db.commit()
    return saved


def load_workload(db: Session, date_from: date, date_to: date, employee_id: int | None = None) -> PlanningWorkloadOut:
    if date_to < date_from:
        raise HTTPException(status_code=400, detail="dateTo раньше dateFrom")
    days = list(iter_days(date_from, date_to))

    employee_query = (
        select(Employee)
        .options(
            joinedload(Employee.expertises).joinedload(EmployeeExpertise.direction),
            joinedload(Employee.department_members).joinedload(DepartmentMember.department),
        )
        .where(Employee.is_active.is_(True))
        .order_by(Employee.full_name)
    )
    if employee_id is not None:
        employee_query = employee_query.where(Employee.id == employee_id)
    employees = db.scalars(employee_query).unique().all()
    employee_ids = [emp.id for emp in employees]

    time_off_map: dict[tuple[int, date], str] = {}
    if employee_ids:
        for row in db.scalars(
            select(EmployeeTimeOffDay).where(
                EmployeeTimeOffDay.employee_id.in_(employee_ids),
                EmployeeTimeOffDay.day >= date_from,
                EmployeeTimeOffDay.day <= date_to,
            )
        ).all():
            time_off_map[(row.employee_id, row.day)] = row.kind

    allocation_rows: list[PlanningAllocation] = []
    if employee_ids:
        allocation_rows = list(
            db.scalars(
                select(PlanningAllocation)
                .options(
                    joinedload(PlanningAllocation.project),
                    joinedload(PlanningAllocation.days),
                )
                .where(
                    PlanningAllocation.allocation_end_date >= date_from,
                    PlanningAllocation.allocation_start_date <= date_to,
                    PlanningAllocation.employee_id.in_(employee_ids),
                )
            ).unique().all()
        )

    by_employee_day: dict[tuple[int, date], list[PlanningWorkloadAllocationCell]] = defaultdict(list)
    for allocation in allocation_rows:
        allocation_time_off = time_off_map  # same map, keyed by (employee_id, day)
        for day_row in allocation.days:
            if day_row.day < date_from or day_row.day > date_to:
                continue
            if allocation_time_off.get((allocation.employee_id, day_row.day)):
                continue
            if not is_working_day(db, day_row.day):
                continue
            by_employee_day[(allocation.employee_id, day_row.day)].append(
                PlanningWorkloadAllocationCell(
                    allocationId=allocation.id,
                    projectId=allocation.project_id,
                    requestNumber=allocation.project.request_number,
                    requestName=allocation.project.request_name,
                    plannedHours=_decimal(day_row.planned_hours),
                    actualHours=_decimal(day_row.actual_hours),
                )
            )

    result_employees: list[PlanningWorkloadEmployeeOut] = []
    for employee in employees:
        day_cells: dict[str, PlanningWorkloadDayCell] = {}
        for day in days:
            working = is_working_day(db, day)
            time_off = time_off_map.get((employee.id, day))
            capacity = _decimal(employee.daily_work_hours) if working and not time_off else Decimal("0")
            allocations = by_employee_day.get((employee.id, day), [])
            planned = sum((cell.plannedHours for cell in allocations), Decimal("0"))
            actual = sum((cell.actualHours for cell in allocations), Decimal("0"))
            available = capacity - planned
            if available < 0:
                available = Decimal("0")
            day_cells[day.isoformat()] = PlanningWorkloadDayCell(
                capacityHours=capacity,
                plannedHours=planned,
                actualHours=actual,
                availableHours=available,
                isWorkingDay=working and not bool(time_off),
                timeOffKind=time_off,
                allocations=allocations,
            )
        result_employees.append(
            PlanningWorkloadEmployeeOut(
                id=employee.id,
                fullName=employee.full_name,
                dailyWorkHours=_decimal(employee.daily_work_hours),
                expertises=_expertise_labels(employee),
                departmentNames=_department_names(employee),
                days=day_cells,
            )
        )

    return PlanningWorkloadOut(dateFrom=date_from, dateTo=date_to, days=days, employees=result_employees)
