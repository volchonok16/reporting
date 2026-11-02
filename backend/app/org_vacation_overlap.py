"""Запрет пересечения отпусков между парами сотрудников."""

from __future__ import annotations

from datetime import date

from fastapi import HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.org_models import DepartmentMember, Employee, EmployeeTimeOffDay, VacationOverlapBlock


def _ordered_pair(employee_id: int, other_id: int) -> tuple[int, int]:
    if employee_id == other_id:
        raise HTTPException(status_code=400, detail="Нельзя запретить пересечение отпуска с самим собой.")
    return (employee_id, other_id) if employee_id < other_id else (other_id, employee_id)


def _format_day(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def list_blocked_partner_ids(db: Session, employee_id: int) -> list[int]:
    rows = db.scalars(
        select(VacationOverlapBlock).where(
            or_(
                VacationOverlapBlock.employee_id_a == employee_id,
                VacationOverlapBlock.employee_id_b == employee_id,
            )
        )
    ).all()
    partners: list[int] = []
    for row in rows:
        partners.append(row.employee_id_b if row.employee_id_a == employee_id else row.employee_id_a)
    return sorted(set(partners))


def load_blocked_partner_ids_map(db: Session, employee_ids: list[int]) -> dict[int, list[int]]:
    if not employee_ids:
        return {}
    rows = db.scalars(
        select(VacationOverlapBlock).where(
            or_(
                VacationOverlapBlock.employee_id_a.in_(employee_ids),
                VacationOverlapBlock.employee_id_b.in_(employee_ids),
            )
        )
    ).all()
    result: dict[int, set[int]] = {eid: set() for eid in employee_ids}
    wanted = set(employee_ids)
    for row in rows:
        if row.employee_id_a in wanted:
            result[row.employee_id_a].add(row.employee_id_b)
        if row.employee_id_b in wanted:
            result[row.employee_id_b].add(row.employee_id_a)
    return {eid: sorted(partners) for eid, partners in result.items()}


def _department_ids_for_employee(db: Session, employee_id: int) -> set[int]:
    return set(
        db.scalars(
            select(DepartmentMember.department_id).where(DepartmentMember.employee_id == employee_id)
        ).all()
    )


def replace_blocked_partners(
    db: Session,
    employee_id: int,
    partner_ids: list[int],
    *,
    actor_org_user_id: int | None = None,
) -> list[int]:
    unique_partners = sorted({int(pid) for pid in partner_ids if int(pid) != employee_id})
    if unique_partners:
        found = {
            row.id
            for row in db.scalars(select(Employee).where(Employee.id.in_(unique_partners))).all()
        }
        missing = [pid for pid in unique_partners if pid not in found]
        if missing:
            raise HTTPException(status_code=400, detail="Сотрудник для запрета пересечения не найден.")
        own_departments = _department_ids_for_employee(db, employee_id)
        if not own_departments:
            raise HTTPException(
                status_code=400,
                detail="Сначала назначьте сотруднику отдел, затем задайте запрет пересечения отпусков.",
            )
        for partner_id in unique_partners:
            partner_departments = _department_ids_for_employee(db, partner_id)
            if own_departments.isdisjoint(partner_departments):
                partner = db.get(Employee, partner_id)
                name = partner.full_name if partner is not None else f"#{partner_id}"
                raise HTTPException(
                    status_code=400,
                    detail=f"Запрет пересечения отпуска возможен только с коллегами того же отдела: {name}.",
                )

    db.execute(
        delete(VacationOverlapBlock).where(
            or_(
                VacationOverlapBlock.employee_id_a == employee_id,
                VacationOverlapBlock.employee_id_b == employee_id,
            )
        )
    )
    for partner_id in unique_partners:
        left, right = _ordered_pair(employee_id, partner_id)
        db.add(
            VacationOverlapBlock(
                employee_id_a=left,
                employee_id_b=right,
                created_by_org_user_id=actor_org_user_id,
            )
        )
    db.flush()
    return unique_partners


def find_vacation_overlap_conflicts(
    db: Session,
    *,
    employee_id: int,
    days: list[date],
) -> list[str]:
    """Возвращает тексты ошибок, если на days есть отпуск у запрещённых партнёров."""
    if not days:
        return []
    partners = list_blocked_partner_ids(db, employee_id)
    if not partners:
        return []

    day_set = set(days)
    conflict_rows = db.scalars(
        select(EmployeeTimeOffDay).where(
            EmployeeTimeOffDay.employee_id.in_(partners),
            EmployeeTimeOffDay.kind == "vacation",
            EmployeeTimeOffDay.day.in_(day_set),
        )
    ).all()
    if not conflict_rows:
        return []

    by_partner: dict[int, list[date]] = {}
    for row in conflict_rows:
        by_partner.setdefault(row.employee_id, []).append(row.day)

    names = {
        emp.id: emp.full_name
        for emp in db.scalars(select(Employee).where(Employee.id.in_(by_partner.keys()))).all()
    }
    errors: list[str] = []
    for partner_id, partner_days in sorted(by_partner.items(), key=lambda item: names.get(item[0], "")):
        ordered = sorted(partner_days)
        first = _format_day(ordered[0])
        last = _format_day(ordered[-1])
        span = first if first == last else f"{first}–{last}"
        name = names.get(partner_id, f"#{partner_id}")
        errors.append(f"Пересечение отпуска с {name} ({span})")
    return errors


def assert_no_vacation_overlap(
    db: Session,
    *,
    employee_id: int,
    from_day: date,
    to_day: date,
) -> None:
    """Проверяет дни отпуска сотрудника в диапазоне после flush."""
    vacation_days = [
        row.day
        for row in db.scalars(
            select(EmployeeTimeOffDay).where(
                EmployeeTimeOffDay.employee_id == employee_id,
                EmployeeTimeOffDay.kind == "vacation",
                EmployeeTimeOffDay.day >= from_day,
                EmployeeTimeOffDay.day <= to_day,
            )
        ).all()
    ]
    errors = find_vacation_overlap_conflicts(db, employee_id=employee_id, days=vacation_days)
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))
