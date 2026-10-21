from __future__ import annotations

from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.app_access import is_superadmin_user
from app.org_models import (
    Department,
    DepartmentMember,
    Employee,
    EmployeeTimeOffDay,
    VacationPlanningUnlock,
    WorkspaceBooking,
)
from app.org_photo_service import photo_public_url
from app.org_service import get_employee_for_org_user, resolve_employee
from app.org_schemas import (
    VacationEmployeeOut,
    VacationPlanningUnlockIn,
    VacationPlanningUnlockOut,
    VacationRangeIn,
    VacationRangeOut,
    VacationScheduleOut,
    VacationTimeOffDayOut,
)
from app.planning_calendar import is_ru_public_holiday
from app.planning_models import ProductionCalendarDay

EDITABLE_KINDS = frozenset({"vacation", "dayoff", "sick_leave", "business_trip"})
ABSENCE_KINDS = frozenset({"vacation", "dayoff", "sick_leave", "business_trip"})
DEFAULT_ANNUAL_LEAVE_DAYS = 28
MIN_LONG_SEGMENT_DAYS = 14
MIN_SHORT_SEGMENT_DAYS = 5


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
        or org_user_role in {"admin", "superadmin"}
    )


def _annual_leave_days(emp: Employee) -> int:
    value = getattr(emp, "annual_leave_days", None)
    if value is None:
        return DEFAULT_ANNUAL_LEAVE_DAYS
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_ANNUAL_LEAVE_DAYS


def is_planning_unlocked(db: Session, year: int) -> bool:
    return db.get(VacationPlanningUnlock, year) is not None


def _is_next_planning_year(year: int) -> bool:
    """Планирование (unlock + подсказки) действует только на следующий календарный год."""
    return year == date.today().year + 1


def _planning_hints_active(db: Session, year: int) -> bool:
    """Подсказки и проверка нормы — только если открыто планирование следующего года."""
    return _is_next_planning_year(year) and is_planning_unlocked(db, year)


def _year_editable(db: Session, meta: dict, year: int) -> bool:
    today_year = date.today().year
    # Текущий и прошлые годы — без ограничений по unlock.
    if year <= today_year:
        return True
    # Следующий год — только после открытия планирования (суперадмин может править и до unlock).
    if year == today_year + 1:
        return is_planning_unlocked(db, year) or is_superadmin_user(meta)
    return is_superadmin_user(meta)


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


def _holiday_keys_for_year(db: Session, year: int) -> set[date]:
    day_from, day_to = _year_bounds(year)
    keys: set[date] = set()
    cursor = day_from
    while cursor <= day_to:
        if is_ru_public_holiday(cursor):
            keys.add(cursor)
        cursor += timedelta(days=1)
    overrides = db.scalars(
        select(ProductionCalendarDay).where(
            ProductionCalendarDay.day >= day_from,
            ProductionCalendarDay.day <= day_to,
        )
    ).all()
    for row in overrides:
        if row.is_working_day:
            keys.discard(row.day)
        else:
            keys.add(row.day)
    return keys


def _is_chargeable_vacation_day(day: date, holiday_keys: set[date]) -> bool:
    """Праздник в период отпуска не расходует норму; выходные расходуют."""
    return day not in holiday_keys


def _vacation_segments(days: list[date]) -> list[list[date]]:
    if not days:
        return []
    ordered = sorted(set(days))
    segments: list[list[date]] = [[ordered[0]]]
    for day in ordered[1:]:
        if day == segments[-1][-1] + timedelta(days=1):
            segments[-1].append(day)
        else:
            segments.append([day])
    return segments


def analyze_vacation_plan(
    *,
    vacation_days: list[date],
    annual_leave_days: int,
    holiday_keys: set[date],
) -> tuple[int, int, list[str], list[str]]:
    """Возвращает used, remaining, warnings, errors."""
    chargeable = [day for day in vacation_days if _is_chargeable_vacation_day(day, holiday_keys)]
    used = len(chargeable)
    remaining = annual_leave_days - used
    errors: list[str] = []
    warnings: list[str] = []

    if used > annual_leave_days:
        errors.append(
            f"Превышена норма отпуска: использовано {used} из {annual_leave_days} дней "
            f"(праздники не считаются)."
        )

    segments = _vacation_segments(vacation_days)
    if not segments:
        return used, remaining, warnings, errors

    lengths = [len(segment) for segment in segments]
    has_long = any(length >= MIN_LONG_SEGMENT_DAYS for length in lengths)
    has_short = any(length >= MIN_SHORT_SEGMENT_DAYS for length in lengths)
    long_count = sum(1 for length in lengths if length >= MIN_LONG_SEGMENT_DAYS)
    short_extra = sum(
        1
        for length in lengths
        if length >= MIN_SHORT_SEGMENT_DAYS and length < MIN_LONG_SEGMENT_DAYS
    )

    if not has_long:
        warnings.append(
            f"Нужен непрерывный отпуск не менее {MIN_LONG_SEGMENT_DAYS} календарных дней."
        )

    # Второй фрагмент ≥5, если норма больше 14 или уже несколько частей.
    needs_second_part = annual_leave_days > MIN_LONG_SEGMENT_DAYS or len(segments) > 1
    if needs_second_part and has_long:
        second_ok = long_count >= 2 or short_extra >= 1
        if not second_ok and (remaining > 0 or len(segments) > 1 or used > MIN_LONG_SEGMENT_DAYS):
            warnings.append(
                f"Нужен ещё один непрерывный отпуск не менее {MIN_SHORT_SEGMENT_DAYS} календарных дней."
            )
    elif needs_second_part and not has_short and used > 0:
        warnings.append(
            f"Нужен непрерывный отпуск не менее {MIN_SHORT_SEGMENT_DAYS} календарных дней "
            f"(и отдельно не менее {MIN_LONG_SEGMENT_DAYS})."
        )

    if remaining > 0 and used > 0:
        warnings.append(f"Осталось запланировать {remaining} дн. из {annual_leave_days}.")
    elif remaining == 0 and used > 0 and not errors:
        # Полностью израсходована норма — подсказка без ошибки.
        pass

    return used, remaining, warnings, errors


def _load_employees(db: Session, department_id: int | None) -> list[Employee]:
    stmt = (
        select(Employee)
        .where(
            Employee.is_active.is_(True),
            Employee.hide_from_pyramid.is_(False),
        )
        .order_by(Employee.full_name)
    )
    if department_id is not None:
        stmt = (
            select(Employee)
            .join(DepartmentMember, DepartmentMember.employee_id == Employee.id)
            .where(
                DepartmentMember.department_id == department_id,
                Employee.is_active.is_(True),
                Employee.hide_from_pyramid.is_(False),
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
    holiday_keys = _holiday_keys_for_year(db, year)
    year_is_editable = _year_editable(db, meta, year)
    # Для UI: unlock имеет смысл только у следующего года.
    planning_unlocked = (
        is_planning_unlocked(db, year) if _is_next_planning_year(year) else False
    )
    hints_active = _planning_hints_active(db, year)
    superadmin = is_superadmin_user(meta)

    days_out: list[VacationTimeOffDayOut] = []
    vacation_by_employee: dict[int, list[date]] = {emp_id: [] for emp_id in employee_ids}
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
        for row in rows:
            days_out.append(
                VacationTimeOffDayOut(
                    employeeId=row.employee_id,
                    day=row.day.isoformat(),
                    kind=row.kind,  # type: ignore[arg-type]
                )
            )
            if row.kind == "vacation":
                vacation_by_employee.setdefault(row.employee_id, []).append(row.day)

    employee_out: list[VacationEmployeeOut] = []
    for emp in employees:
        annual = _annual_leave_days(emp)
        used, remaining, warnings, errors = analyze_vacation_plan(
            vacation_days=vacation_by_employee.get(emp.id, []),
            annual_leave_days=annual,
            holiday_keys=holiday_keys,
        )
        if not hints_active:
            warnings = []
            errors = []
        base_can_edit = can_edit_employee_vacation(meta, actor_employee_id, emp.id)
        employee_out.append(
            VacationEmployeeOut(
                id=emp.id,
                publicId=str(emp.public_id),
                fullName=emp.full_name,
                departmentName=department_names.get(emp.id),
                position=emp.position,
                managerId=emp.manager_id,
                photoUrl=photo_public_url(emp.photo_path),
                canEdit=base_can_edit and year_is_editable,
                isSelf=actor_employee_id == emp.id,
                annualLeaveDays=annual,
                usedLeaveDays=used if hints_active else 0,
                remainingLeaveDays=remaining if hints_active else annual,
                planningWarnings=warnings,
                planningErrors=errors,
            )
        )

    return VacationScheduleOut(
        year=year,
        departmentId=department_id,
        actorEmployeeId=actor_employee_id,
        planningUnlocked=planning_unlocked,
        nextYearEditable=year_is_editable,
        isSuperAdmin=superadmin,
        employees=employee_out,
        timeOffDays=days_out,
    )


def set_vacation_planning_unlock(
    db: Session,
    data: VacationPlanningUnlockIn,
    meta: dict,
) -> VacationPlanningUnlockOut:
    if not is_superadmin_user(meta):
        raise HTTPException(status_code=403, detail="Только суперадминистратор может открыть планирование.")
    year = int(data.year)
    if not _is_next_planning_year(year):
        raise HTTPException(
            status_code=400,
            detail="Планирование открывается только для следующего календарного года.",
        )
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    existing = db.get(VacationPlanningUnlock, year)
    if data.unlocked:
        if existing is None:
            db.add(
                VacationPlanningUnlock(
                    year=year,
                    unlocked_by_org_user_id=org_user_id,
                )
            )
        else:
            existing.unlocked_by_org_user_id = org_user_id
        db.commit()
        row = db.get(VacationPlanningUnlock, year)
        return VacationPlanningUnlockOut(
            year=year,
            planningUnlocked=True,
            unlockedAt=row.unlocked_at.isoformat() if row and row.unlocked_at else None,
        )

    if existing is not None:
        db.delete(existing)
        db.commit()
    return VacationPlanningUnlockOut(year=year, planningUnlocked=False, unlockedAt=None)


def upsert_vacation_range(db: Session, data: VacationRangeIn, meta: dict) -> VacationRangeOut:
    employee = resolve_employee(db, data.employeeRef)
    if not employee.is_active:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")
    employee_id = employee.id

    actor_employee_id = _actor_employee_id(db, meta)
    if not can_edit_employee_vacation(meta, actor_employee_id, employee_id):
        raise HTTPException(status_code=403, detail="Недостаточно прав для редактирования графика.")

    start = _parse_day(data.fromDay)
    end = _parse_day(data.toDay)
    if start > end:
        start, end = end, start

    year = start.year
    if end.year != year:
        raise HTTPException(status_code=400, detail="Диапазон должен быть в пределах одного года.")
    if not _year_editable(db, meta, year):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Редактирование {year} года ещё не открыто. "
                "Суперадминистратор включает его кнопкой «Планирование отпуска»."
            ),
        )

    if data.kind != "erase" and data.kind not in EDITABLE_KINDS:
        raise HTTPException(status_code=400, detail="Недопустимый тип отсутствия.")

    holiday_keys = _holiday_keys_for_year(db, year)
    annual = _annual_leave_days(employee)

    affected = 0
    if data.kind == "erase":
        result = db.execute(
            delete(EmployeeTimeOffDay).where(
                EmployeeTimeOffDay.employee_id == employee_id,
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
                    EmployeeTimeOffDay.employee_id == employee_id,
                    EmployeeTimeOffDay.day == cursor,
                )
            )
            if existing is None:
                db.add(
                    EmployeeTimeOffDay(
                        employee_id=employee_id,
                        day=cursor,
                        kind=data.kind,
                    )
                )
                affected += 1
            elif existing.kind != data.kind:
                existing.kind = data.kind
                affected += 1
            cursor += timedelta(days=1)

        if data.kind in ABSENCE_KINDS:
            db.execute(
                delete(WorkspaceBooking).where(
                    WorkspaceBooking.employee_id == employee_id,
                    WorkspaceBooking.day >= start,
                    WorkspaceBooking.day <= end,
                )
            )

    db.flush()

    day_from, day_to = _year_bounds(year)
    year_rows = db.scalars(
        select(EmployeeTimeOffDay).where(
            EmployeeTimeOffDay.employee_id == employee_id,
            EmployeeTimeOffDay.day >= day_from,
            EmployeeTimeOffDay.day <= day_to,
            EmployeeTimeOffDay.kind == "vacation",
        )
    ).all()
    vacation_days = [row.day for row in year_rows]
    used, remaining, warnings, errors = analyze_vacation_plan(
        vacation_days=vacation_days,
        annual_leave_days=annual,
        holiday_keys=holiday_keys,
    )
    hints_active = _planning_hints_active(db, year)
    if not hints_active:
        warnings = []
        errors = []

    # Жёсткая проверка нормы — только в режиме открытого планирования следующего года.
    if hints_active and errors and data.kind == "vacation":
        db.rollback()
        raise HTTPException(status_code=400, detail="; ".join(errors))

    chargeable_in_range = 0
    if hints_active and data.kind == "vacation":
        cursor = start
        while cursor <= end:
            if _is_chargeable_vacation_day(cursor, holiday_keys):
                chargeable_in_range += 1
            cursor += timedelta(days=1)

    db.commit()
    return VacationRangeOut(
        affectedDays=affected,
        usedLeaveDays=used if hints_active else 0,
        remainingLeaveDays=remaining if hints_active else annual,
        annualLeaveDays=annual,
        chargeableDaysInRange=chargeable_in_range,
        planningWarnings=warnings,
        planningErrors=errors,
    )
