from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth_sessions import get_session_with_meta
from app.db import get_db
from app.org_routes import require_org_admin
from app.planning_schemas import (
    PlanningAllocationDaysIn,
    PlanningAllocationIn,
    PlanningAllocationOut,
    PlanningAllocationUpdateIn,
    PlanningComplexityIn,
    PlanningComplexityOut,
    PlanningCustomerDepartmentIn,
    PlanningCustomerDepartmentOut,
    PlanningCustomerDepartmentUpdateIn,
    PlanningProjectIn,
    PlanningProjectOut,
    PlanningProjectUpdateIn,
    PlanningWorkloadOut,
    ProductionCalendarBulkIn,
    ProductionCalendarDayOut,
)
from app.planning_service import (
    create_allocation,
    create_complexity,
    create_customer_department,
    create_project,
    delete_allocation,
    delete_customer_department,
    delete_project,
    get_project,
    list_allocations,
    list_calendar_days,
    list_complexities,
    list_customer_departments,
    list_projects,
    load_workload,
    update_allocation,
    update_allocation_days,
    update_customer_department,
    update_project,
    upsert_calendar_days,
)

router = APIRouter(prefix="/api/planning", tags=["planning"])


def _load_session_meta(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict:
    from app.app_access import is_voice_only

    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    return meta


@router.get("/complexities", response_model=list[PlanningComplexityOut])
def api_list_complexities(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[PlanningComplexityOut]:
    return list_complexities(db)


@router.post("/complexities", response_model=PlanningComplexityOut)
def api_create_complexity(
    data: PlanningComplexityIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> PlanningComplexityOut:
    return create_complexity(db, data)


@router.get("/customer-departments", response_model=list[PlanningCustomerDepartmentOut])
def api_list_customer_departments(
    active_only: bool = Query(default=False, alias="activeOnly"),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[PlanningCustomerDepartmentOut]:
    return list_customer_departments(db, active_only=active_only)


@router.post("/customer-departments", response_model=PlanningCustomerDepartmentOut)
def api_create_customer_department(
    data: PlanningCustomerDepartmentIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningCustomerDepartmentOut:
    return create_customer_department(db, data)


@router.patch("/customer-departments/{department_id}", response_model=PlanningCustomerDepartmentOut)
def api_update_customer_department(
    department_id: int,
    data: PlanningCustomerDepartmentUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningCustomerDepartmentOut:
    return update_customer_department(db, department_id, data)


@router.delete("/customer-departments/{department_id}")
def api_delete_customer_department(
    department_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_customer_department(db, department_id)
    return {"ok": True}


@router.get("/projects", response_model=list[PlanningProjectOut])
def api_list_projects(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[PlanningProjectOut]:
    return list_projects(db)


@router.post("/projects", response_model=PlanningProjectOut)
def api_create_project(
    data: PlanningProjectIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> PlanningProjectOut:
    return create_project(db, data, meta)


@router.get("/projects/{project_id}", response_model=PlanningProjectOut)
def api_get_project(
    project_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningProjectOut:
    return get_project(db, project_id)


@router.patch("/projects/{project_id}", response_model=PlanningProjectOut)
def api_update_project(
    project_id: int,
    data: PlanningProjectUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningProjectOut:
    return update_project(db, project_id, data)


@router.delete("/projects/{project_id}")
def api_delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_project(db, project_id)
    return {"ok": True}


@router.get("/projects/{project_id}/allocations", response_model=list[PlanningAllocationOut])
def api_list_allocations(
    project_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[PlanningAllocationOut]:
    return list_allocations(db, project_id)


@router.post("/projects/{project_id}/allocations", response_model=PlanningAllocationOut)
def api_create_allocation(
    project_id: int,
    data: PlanningAllocationIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> PlanningAllocationOut:
    return create_allocation(db, project_id, data, meta)


@router.patch("/allocations/{allocation_id}", response_model=PlanningAllocationOut)
def api_update_allocation(
    allocation_id: int,
    data: PlanningAllocationUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningAllocationOut:
    return update_allocation(db, allocation_id, data)


@router.put("/allocations/{allocation_id}/days", response_model=PlanningAllocationOut)
def api_update_allocation_days(
    allocation_id: int,
    data: PlanningAllocationDaysIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningAllocationOut:
    return update_allocation_days(db, allocation_id, data.days)


@router.delete("/allocations/{allocation_id}")
def api_delete_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_allocation(db, allocation_id)
    return {"ok": True}


@router.get("/workload", response_model=PlanningWorkloadOut)
def api_workload(
    date_from: date = Query(alias="dateFrom"),
    date_to: date = Query(alias="dateTo"),
    employee_id: int | None = Query(default=None, alias="employeeId"),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> PlanningWorkloadOut:
    return load_workload(db, date_from, date_to, employee_id)


@router.get("/calendar", response_model=list[ProductionCalendarDayOut])
def api_calendar(
    year: int = Query(ge=2000, le=2100),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[ProductionCalendarDayOut]:
    return list_calendar_days(db, year)


@router.put("/calendar", response_model=list[ProductionCalendarDayOut])
def api_calendar_upsert(
    data: ProductionCalendarBulkIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> list[ProductionCalendarDayOut]:
    return upsert_calendar_days(db, data.days)
