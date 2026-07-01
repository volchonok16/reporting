from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload

from app.org_models import (
    Department,
    DepartmentMember,
    Employee,
    EmployeeOfficeDay,
    EmployeeTimeOffDay,
    WorkspaceBooking,
    WorkspacePlace,
)
from app.org_photo_service import photo_public_url
from app.org_schemas import (
    OfficeDayOut,
    OfficeDayRangeIn,
    OfficeDayRangeOut,
    VacationEmployeeOut,
    VacationTimeOffDayOut,
    WorkspaceBookingCellOut,
    WorkspaceOfficePresenceOut,
    WorkspacePresenceCellOut,
    WorkspaceBookingScheduleOut,
    WorkspaceBookingToggleIn,
    WorkspaceBookingToggleOut,
    WorkspacePlaceIn,
    WorkspacePlaceOut,
    WorkspacePlaceUpdateIn,
)
from app.org_vacation_service import _actor_employee_id, _is_org_admin, can_edit_employee_vacation


def _parse_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректная дата.") from exc


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    if month < 1 or month > 12:
        raise HTTPException(status_code=400, detail="Некорректный месяц.")
    last_day = monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


def _year_bounds(year: int) -> tuple[date, date]:
    return date(year, 1, 1), date(year, 12, 31)


def _iter_days(day_from: date, day_to: date) -> list[date]:
    days: list[date] = []
    cursor = day_from
    while cursor <= day_to:
        days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _load_active_places(db: Session) -> list[WorkspacePlace]:
    return list(
        db.scalars(
            select(WorkspacePlace)
            .where(WorkspacePlace.is_active.is_(True))
            .order_by(WorkspacePlace.sort_order, WorkspacePlace.name)
        ).all()
    )


def _load_booking_employees(db: Session) -> list[Employee]:
    return list(
        db.scalars(select(Employee).where(Employee.is_active.is_(True)).order_by(Employee.full_name)).unique().all()
    )


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


def get_workspace_booking_schedule(
    db: Session,
    *,
    year: int,
    month: int | None,
    meta: dict,
) -> WorkspaceBookingScheduleOut:
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Некорректный год.")

    if month is not None:
        day_from, day_to = _month_bounds(year, month)
    else:
        day_from, day_to = _year_bounds(year)
    actor_employee_id = _actor_employee_id(db, meta)
    is_admin = _is_org_admin(meta)
    places = _load_active_places(db)

    bookings_out: list[WorkspaceBookingCellOut] = []
    if places:
        rows = db.scalars(
            select(WorkspaceBooking)
            .options(joinedload(WorkspaceBooking.employee))
            .where(
                WorkspaceBooking.day >= day_from,
                WorkspaceBooking.day <= day_to,
            )
            .order_by(WorkspaceBooking.day, WorkspaceBooking.place_id)
        ).unique().all()
        for row in rows:
            can_release = can_edit_employee_vacation(meta, actor_employee_id, row.employee_id)
            bookings_out.append(
                WorkspaceBookingCellOut(
                    placeId=row.place_id,
                    day=row.day.isoformat(),
                    employeeId=row.employee_id,
                    employeeName=row.employee.full_name if row.employee else "",
                    isSelf=actor_employee_id == row.employee_id,
                    canRelease=can_release,
                )
            )

    employees = _load_booking_employees(db)
    department_names = _load_primary_department_names(db, [emp.id for emp in employees])
    employee_out = [
        VacationEmployeeOut(
            id=emp.id,
            fullName=emp.full_name,
            departmentName=department_names.get(emp.id),
            position=emp.position,
            managerId=emp.manager_id,
            photoUrl=None,
            canEdit=can_edit_employee_vacation(meta, actor_employee_id, emp.id),
            isSelf=actor_employee_id == emp.id,
        )
        for emp in employees
    ]

    return WorkspaceBookingScheduleOut(
        year=year,
        month=month,
        actorEmployeeId=actor_employee_id,
        isAdmin=is_admin,
        places=[
            WorkspacePlaceOut(id=p.id, name=p.name, sortOrder=p.sort_order, isActive=p.is_active) for p in places
        ],
        bookings=bookings_out,
        employees=employee_out,
    )


def get_workspace_office_presence(
    db: Session,
    *,
    year: int,
    month: int | None,
    meta: dict,
) -> WorkspaceOfficePresenceOut:
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Некорректный год.")
    if month is not None:
        day_from, day_to = _month_bounds(year, month)
    else:
        day_from, day_to = _year_bounds(year)

    actor_employee_id = _actor_employee_id(db, meta)
    employees = _load_booking_employees(db)
    employee_ids = [employee.id for employee in employees]
    department_names = _load_primary_department_names(db, employee_ids)

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

    time_off_rows = db.scalars(
        select(EmployeeTimeOffDay)
        .where(
            EmployeeTimeOffDay.day >= day_from,
            EmployeeTimeOffDay.day <= day_to,
            EmployeeTimeOffDay.employee_id.in_(employee_ids) if employee_ids else False,
        )
        .order_by(EmployeeTimeOffDay.employee_id, EmployeeTimeOffDay.day)
    ).all()
    time_off_days = [
        VacationTimeOffDayOut(
            employeeId=row.employee_id,
            day=row.day.isoformat(),
            kind=row.kind,  # type: ignore[arg-type]
        )
        for row in time_off_rows
    ]
    vacation_keys = {
        (row.employee_id, row.day)
        for row in time_off_rows
        if row.kind == "vacation"
    }

    presence_rows = db.scalars(
        select(WorkspaceBooking)
        .options(joinedload(WorkspaceBooking.place))
        .where(
            WorkspaceBooking.day >= day_from,
            WorkspaceBooking.day <= day_to,
            WorkspaceBooking.employee_id.in_(employee_ids) if employee_ids else False,
        )
        .order_by(WorkspaceBooking.employee_id, WorkspaceBooking.day)
    ).all()
    presence_out = [
        WorkspacePresenceCellOut(
            employeeId=row.employee_id,
            day=row.day.isoformat(),
            placeId=row.place_id,
            placeName=row.place.name if row.place else "",
        )
        for row in presence_rows
        if (row.employee_id, row.day) not in vacation_keys
    ]

    office_rows = db.scalars(
        select(EmployeeOfficeDay)
        .where(
            EmployeeOfficeDay.day >= day_from,
            EmployeeOfficeDay.day <= day_to,
            EmployeeOfficeDay.employee_id.in_(employee_ids) if employee_ids else False,
        )
        .order_by(EmployeeOfficeDay.employee_id, EmployeeOfficeDay.day)
    ).all()
    office_days = [
        OfficeDayOut(employeeId=row.employee_id, day=row.day.isoformat())
        for row in office_rows
        if (row.employee_id, row.day) not in vacation_keys
    ]

    return WorkspaceOfficePresenceOut(
        year=year,
        month=month,
        employees=employee_out,
        presence=presence_out,
        officeDays=office_days,
        timeOffDays=time_off_days,
    )


def get_profile_office_days(
    db: Session,
    *,
    year: int,
    month: int,
    meta: dict,
) -> list[OfficeDayOut]:
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Некорректный год.")
    day_from, day_to = _month_bounds(year, month)
    actor_employee_id = _actor_employee_id(db, meta)
    if actor_employee_id is None:
        raise HTTPException(status_code=400, detail="Календарь офиса доступен после привязки сотрудника.")

    rows = db.scalars(
        select(EmployeeOfficeDay)
        .where(
            EmployeeOfficeDay.employee_id == actor_employee_id,
            EmployeeOfficeDay.day >= day_from,
            EmployeeOfficeDay.day <= day_to,
        )
        .order_by(EmployeeOfficeDay.day)
    ).all()
    return [OfficeDayOut(employeeId=row.employee_id, day=row.day.isoformat()) for row in rows]


def get_employee_office_days(
    db: Session,
    *,
    employee_id: int,
    year: int,
    month: int,
) -> list[OfficeDayOut]:
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Некорректный год.")
    day_from, day_to = _month_bounds(year, month)
    employee = db.get(Employee, employee_id)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")

    rows = db.scalars(
        select(EmployeeOfficeDay).where(
            EmployeeOfficeDay.employee_id == employee_id,
            EmployeeOfficeDay.day >= day_from,
            EmployeeOfficeDay.day <= day_to,
        )
    ).all()
    return [OfficeDayOut(employeeId=row.employee_id, day=row.day.isoformat()) for row in rows]


def upsert_profile_office_days(
    db: Session,
    data: OfficeDayRangeIn,
    meta: dict,
) -> OfficeDayRangeOut:
    actor_employee_id = _actor_employee_id(db, meta)
    if actor_employee_id is None:
        raise HTTPException(status_code=400, detail="Календарь офиса доступен после привязки сотрудника.")

    employee = db.get(Employee, actor_employee_id)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")

    start = _parse_day(data.fromDay)
    end = _parse_day(data.toDay)
    if start > end:
        start, end = end, start

    affected = 0
    for target_day in _iter_days(start, end):
        existing = db.scalar(
            select(EmployeeOfficeDay).where(
                EmployeeOfficeDay.employee_id == actor_employee_id,
                EmployeeOfficeDay.day == target_day,
            )
        )
        if data.present:
            if existing is None:
                db.add(EmployeeOfficeDay(employee_id=actor_employee_id, day=target_day))
                affected += 1
        elif existing is not None:
            db.delete(existing)
            affected += 1
    db.commit()
    return OfficeDayRangeOut(affectedDays=affected)


def upsert_employee_office_days(
    db: Session,
    *,
    employee_id: int,
    data: OfficeDayRangeIn,
) -> OfficeDayRangeOut:
    employee = db.get(Employee, employee_id)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")

    start = _parse_day(data.fromDay)
    end = _parse_day(data.toDay)
    if start > end:
        start, end = end, start

    affected = 0
    for target_day in _iter_days(start, end):
        existing = db.scalar(
            select(EmployeeOfficeDay).where(
                EmployeeOfficeDay.employee_id == employee_id,
                EmployeeOfficeDay.day == target_day,
            )
        )
        if data.present:
            if existing is None:
                db.add(EmployeeOfficeDay(employee_id=employee_id, day=target_day))
                affected += 1
        elif existing is not None:
            db.delete(existing)
            affected += 1
    db.commit()
    return OfficeDayRangeOut(affectedDays=affected)


def toggle_workspace_booking(db: Session, data: WorkspaceBookingToggleIn, meta: dict) -> WorkspaceBookingToggleOut:
    place = db.get(WorkspacePlace, data.placeId)
    if place is None or not place.is_active:
        raise HTTPException(status_code=404, detail="Место не найдено.")

    day = _parse_day(data.day)
    actor_employee_id = _actor_employee_id(db, meta)
    is_admin = _is_org_admin(meta)

    existing = db.scalar(
        select(WorkspaceBooking).where(
            WorkspaceBooking.place_id == data.placeId,
            WorkspaceBooking.day == day,
        )
    )

    if data.action == "release":
        if existing is None:
            return WorkspaceBookingToggleOut(action="release", booked=False)
        if not can_edit_employee_vacation(meta, actor_employee_id, existing.employee_id):
            raise HTTPException(status_code=403, detail="Недостаточно прав для снятия брони.")
        db.delete(existing)
        db.commit()
        return WorkspaceBookingToggleOut(action="release", booked=False)

    target_employee_id = data.employeeId
    if target_employee_id is None:
        target_employee_id = actor_employee_id
    if target_employee_id is None:
        raise HTTPException(status_code=400, detail="Укажите сотрудника или привяжите учётную запись.")

    if not can_edit_employee_vacation(meta, actor_employee_id, target_employee_id):
        raise HTTPException(status_code=403, detail="Недостаточно прав для бронирования.")

    employee = db.get(Employee, target_employee_id)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=404, detail="Сотрудник не найден.")

    vacation_day = db.scalar(
        select(EmployeeTimeOffDay).where(
            EmployeeTimeOffDay.employee_id == target_employee_id,
            EmployeeTimeOffDay.day == day,
            EmployeeTimeOffDay.kind == "vacation",
        )
    )
    if vacation_day is not None:
        employee_day_booking = db.scalar(
            select(WorkspaceBooking).where(
                WorkspaceBooking.employee_id == target_employee_id,
                WorkspaceBooking.day == day,
            )
        )
        if employee_day_booking is not None:
            db.delete(employee_day_booking)
            db.commit()
        return WorkspaceBookingToggleOut(
            action="book",
            booked=False,
            employeeId=target_employee_id,
            notice="У вас запланирован отпуск на эти даты.",
        )

    if existing is not None:
        if existing.employee_id == target_employee_id:
            return WorkspaceBookingToggleOut(action="book", booked=True, employeeId=target_employee_id)
        if not is_admin:
            raise HTTPException(status_code=409, detail="Место уже занято.")
        if not can_edit_employee_vacation(meta, actor_employee_id, existing.employee_id):
            raise HTTPException(status_code=403, detail="Недостаточно прав для перебронирования.")
        db.delete(existing)

    employee_day_booking = db.scalar(
        select(WorkspaceBooking).where(
            WorkspaceBooking.employee_id == target_employee_id,
            WorkspaceBooking.day == day,
        )
    )
    if employee_day_booking is not None and employee_day_booking.place_id != data.placeId:
        raise HTTPException(
            status_code=409,
            detail="У сотрудника уже есть бронь на этот день.",
        )
    if employee_day_booking is not None:
        employee_day_booking.place_id = data.placeId
    else:
        db.add(
            WorkspaceBooking(
                place_id=data.placeId,
                employee_id=target_employee_id,
                day=day,
            )
        )

    db.commit()
    return WorkspaceBookingToggleOut(action="book", booked=True, employeeId=target_employee_id)


def list_workspace_places(db: Session) -> list[WorkspacePlaceOut]:
    places = db.scalars(select(WorkspacePlace).order_by(WorkspacePlace.sort_order, WorkspacePlace.name)).all()
    return [
        WorkspacePlaceOut(id=p.id, name=p.name, sortOrder=p.sort_order, isActive=p.is_active) for p in places
    ]


def create_workspace_place(db: Session, data: WorkspacePlaceIn) -> WorkspacePlaceOut:
    place = WorkspacePlace(name=data.name.strip(), sort_order=data.sortOrder, is_active=data.isActive)
    db.add(place)
    db.commit()
    db.refresh(place)
    return WorkspacePlaceOut(id=place.id, name=place.name, sortOrder=place.sort_order, isActive=place.is_active)


def update_workspace_place(db: Session, place_id: int, data: WorkspacePlaceUpdateIn) -> WorkspacePlaceOut:
    place = db.get(WorkspacePlace, place_id)
    if place is None:
        raise HTTPException(status_code=404, detail="Место не найдено.")
    if data.name is not None:
        place.name = data.name.strip()
    if data.sortOrder is not None:
        place.sort_order = data.sortOrder
    if data.isActive is not None:
        place.is_active = data.isActive
    db.commit()
    db.refresh(place)
    return WorkspacePlaceOut(id=place.id, name=place.name, sortOrder=place.sort_order, isActive=place.is_active)


def delete_workspace_place(db: Session, place_id: int) -> None:
    place = db.get(WorkspacePlace, place_id)
    if place is None:
        raise HTTPException(status_code=404, detail="Место не найдено.")
    db.execute(delete(WorkspaceBooking).where(WorkspaceBooking.place_id == place_id))
    db.delete(place)
    db.commit()
