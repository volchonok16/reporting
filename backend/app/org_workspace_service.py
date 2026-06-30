from __future__ import annotations

from calendar import monthrange
from datetime import date

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload

from app.org_models import Employee, WorkspaceBooking, WorkspacePlace
from app.org_schemas import (
    VacationEmployeeOut,
    WorkspaceBookingCellOut,
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


def get_workspace_booking_schedule(
    db: Session,
    *,
    year: int,
    month: int,
    meta: dict,
) -> WorkspaceBookingScheduleOut:
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Некорректный год.")

    day_from, day_to = _month_bounds(year, month)
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
    employee_out = [
        VacationEmployeeOut(
            id=emp.id,
            fullName=emp.full_name,
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
