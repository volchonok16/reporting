from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from datetime import date
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.auth_sessions import get_session_with_meta
from app.db import get_db
from app.org_photo_service import load_photo_content
from app.org_schemas import (
    DepartmentIn,
    DepartmentMemberIn,
    DepartmentMemberOut,
    DepartmentMemberUpdateIn,
    DepartmentOut,
    EmployeeExpertiseIn,
    EmployeeDetailOut,
    EmployeeIn,
    EmployeeOptionOut,
    EmployeeOut,
    EmployeeUpdateIn,
    ExpertiseDirectionIn,
    ExpertiseDirectionOut,
    JobPositionIn,
    JobPositionOut,
    OrgChartLayoutIn,
    OrgChartLayoutOut,
    OrgChartOut,
    OrgUserIn,
    OrgUserOut,
    OrgUserUpdateIn,
    OfficeDayOut,
    OfficeDayRangeIn,
    OfficeDayRangeOut,
    PasswordChangeIn,
    ProfileOut,
    ProfileUpdateIn,
    SelectOptionOut,
    TeamRoleIn,
    TeamRoleOut,
    VacationRangeIn,
    VacationRangeOut,
    VacationScheduleOut,
    WorkspaceOfficePresenceOut,
    WorkspaceBookingScheduleOut,
    WorkspaceBookingToggleIn,
    WorkspaceBookingToggleOut,
    WorkspacePlaceIn,
    WorkspacePlaceOut,
    WorkspacePlaceUpdateIn,
)
from app.org_service import (
    add_department_member,
    add_employee_expertise,
    change_password,
    create_department,
    create_employee,
    create_expertise_direction,
    create_job_position,
    create_org_user_account,
    create_team_role,
    delete_department,
    delete_department_member,
    delete_employee,
    delete_employee_expertise,
    get_department,
    get_employee,
    get_org_chart,
    get_org_chart_layout,
    list_department_members,
    list_departments,
    list_employee_options,
    list_employees,
    list_expertise_directions,
    list_job_positions,
    list_org_users,
    list_team_roles,
    load_profile,
    update_department,
    update_department_member,
    update_employee,
    update_org_user_account,
    update_profile,
    save_org_chart_layout,
    upload_employee_photo,
)
from app.org_service import update_profile_photo as update_profile_photo_service

from app.org_vacation_service import get_vacation_schedule, upsert_vacation_range
from app.org_workspace_service import (
    create_workspace_place,
    delete_workspace_place,
    get_employee_office_days,
    get_workspace_booking_schedule,
    get_workspace_office_presence,
    get_profile_office_days,
    list_workspace_places,
    toggle_workspace_booking,
    upsert_employee_office_days,
    upsert_profile_office_days,
    update_workspace_place,
)

router = APIRouter(prefix="/api/org", tags=["org"])


def _load_session_meta(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict:
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    return meta


def require_org_admin(meta: dict = Depends(_load_session_meta)) -> dict:
    if meta.get("app_role") == "roadmap":
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    if meta.get("org_user_role") == "admin":
        return meta
    if meta.get("auth_mode") == "app_user" and meta.get("app_role") == "full":
        return meta
    if meta.get("auth_mode") == "pat":
        return meta
    raise HTTPException(status_code=403, detail="Недостаточно прав для управления отделами.")


@router.get("/job-positions", response_model=list[JobPositionOut])
def api_list_job_positions(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[JobPositionOut]:
    return list_job_positions(db)


@router.post("/job-positions", response_model=JobPositionOut)
def api_create_job_position(
    data: JobPositionIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> JobPositionOut:
    return create_job_position(db, data)


@router.get("/team-roles", response_model=list[TeamRoleOut])
def api_list_team_roles(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[TeamRoleOut]:
    return list_team_roles(db)


@router.post("/team-roles", response_model=TeamRoleOut)
def api_create_team_role(
    data: TeamRoleIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> TeamRoleOut:
    return create_team_role(db, data)


@router.get("/expertise-directions", response_model=list[ExpertiseDirectionOut])
def api_list_expertise_directions(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[ExpertiseDirectionOut]:
    return list_expertise_directions(db)


@router.post("/expertise-directions", response_model=ExpertiseDirectionOut)
def api_create_expertise_direction(
    data: ExpertiseDirectionIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> ExpertiseDirectionOut:
    return create_expertise_direction(db, data)


@router.get("/employee-options", response_model=list[EmployeeOptionOut])
def api_employee_options(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[EmployeeOptionOut]:
    return list_employee_options(db)


@router.get("/employees", response_model=list[EmployeeOut])
def api_list_employees(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[EmployeeOut]:
    return list_employees(db)


@router.get("/employees/{employee_ref}", response_model=EmployeeDetailOut)
def api_get_employee(
    employee_ref: str,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> EmployeeDetailOut:
    return get_employee(db, employee_ref)


@router.post("/employees", response_model=EmployeeOut)
def api_create_employee(
    data: EmployeeIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> EmployeeOut:
    return create_employee(db, data)


@router.patch("/employees/{employee_ref}", response_model=EmployeeOut)
def api_update_employee(
    employee_ref: str,
    data: EmployeeUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> EmployeeOut:
    return update_employee(db, employee_ref, data)


@router.delete("/employees/{employee_ref}")
def api_delete_employee(
    employee_ref: str,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> dict[str, bool]:
    delete_employee(db, employee_ref)
    return {"ok": True}


@router.get("/employees/{employee_ref}/office-days", response_model=list[OfficeDayOut])
def api_employee_office_days(
    employee_ref: str,
    year: int = Query(default=date.today().year),
    month: int = Query(default=date.today().month, ge=1, le=12),
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> list[OfficeDayOut]:
    from app.org_service import resolve_employee

    employee_id = resolve_employee(db, employee_ref).id
    return get_employee_office_days(db, employee_id=employee_id, year=year, month=month)


@router.put("/employees/{employee_ref}/office-days/range", response_model=OfficeDayRangeOut)
def api_employee_office_days_range(
    employee_ref: str,
    data: OfficeDayRangeIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> OfficeDayRangeOut:
    from app.org_service import resolve_employee

    employee_id = resolve_employee(db, employee_ref).id
    return upsert_employee_office_days(db, employee_id=employee_id, data=data)


@router.post("/employees/{employee_ref}/photo", response_model=EmployeeOut)
async def api_upload_employee_photo(
    employee_ref: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> EmployeeOut:
    return await upload_employee_photo(db, employee_ref, file)


@router.post("/employees/{employee_ref}/expertise", response_model=EmployeeOut)
def api_add_expertise(
    employee_ref: str,
    data: EmployeeExpertiseIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> EmployeeOut:
    return add_employee_expertise(db, employee_ref, data)


@router.delete("/employees/{employee_ref}/expertise/{expertise_id}", response_model=EmployeeOut)
def api_delete_expertise(
    employee_ref: str,
    expertise_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> EmployeeOut:
    return delete_employee_expertise(db, employee_ref, expertise_id)


@router.get("/departments", response_model=list[DepartmentOut])
def api_list_departments(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[DepartmentOut]:
    return list_departments(db)


@router.get("/departments/{department_id}", response_model=DepartmentOut)
def api_get_department(
    department_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> DepartmentOut:
    return get_department(db, department_id)


@router.post("/departments", response_model=DepartmentOut)
def api_create_department(
    data: DepartmentIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> DepartmentOut:
    return create_department(db, data)


@router.put("/departments/{department_id}", response_model=DepartmentOut)
def api_update_department(
    department_id: int,
    data: DepartmentIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> DepartmentOut:
    return update_department(db, department_id, data)


@router.delete("/departments/{department_id}")
def api_delete_department(
    department_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> dict[str, bool]:
    delete_department(db, department_id)
    return {"ok": True}


@router.get("/departments/{department_id}/members", response_model=list[DepartmentMemberOut])
def api_list_members(
    department_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[DepartmentMemberOut]:
    return list_department_members(db, department_id)


@router.post("/departments/{department_id}/members", response_model=DepartmentMemberOut)
def api_add_member(
    department_id: int,
    data: DepartmentMemberIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> DepartmentMemberOut:
    return add_department_member(db, department_id, data)


@router.patch("/departments/{department_id}/members/{member_id}", response_model=DepartmentMemberOut)
def api_update_member(
    department_id: int,
    member_id: int,
    data: DepartmentMemberUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> DepartmentMemberOut:
    return update_department_member(db, department_id, member_id, data)


@router.delete("/departments/{department_id}/members/{member_id}")
def api_delete_member(
    department_id: int,
    member_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> dict[str, bool]:
    delete_department_member(db, department_id, member_id)
    return {"ok": True}


@router.get("/org-chart", response_model=OrgChartOut)
def api_org_chart(
    department_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> OrgChartOut:
    return get_org_chart(db, department_id)


@router.get("/org-chart-layout", response_model=OrgChartLayoutOut)
def api_org_chart_layout(
    scope: str = Query(default="company"),
    department_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> OrgChartLayoutOut:
    return get_org_chart_layout(db, scope, department_id)


@router.put("/org-chart-layout", response_model=OrgChartLayoutOut)
def api_save_org_chart_layout(
    data: OrgChartLayoutIn,
    scope: str = Query(default="company"),
    department_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> OrgChartLayoutOut:
    return save_org_chart_layout(db, data, scope, department_id)


@router.get("/vacations", response_model=VacationScheduleOut)
def api_vacation_schedule(
    year: int = Query(default=date.today().year),
    department_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> VacationScheduleOut:
    return get_vacation_schedule(db, year=year, department_id=department_id, meta=meta)


@router.put("/vacations/range", response_model=VacationRangeOut)
def api_vacation_range(
    data: VacationRangeIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> VacationRangeOut:
    return upsert_vacation_range(db, data, meta)


@router.get("/workspace/bookings", response_model=WorkspaceBookingScheduleOut)
def api_workspace_bookings(
    year: int = Query(default=date.today().year),
    month: int | None = Query(default=None, ge=1, le=12),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> WorkspaceBookingScheduleOut:
    return get_workspace_booking_schedule(db, year=year, month=month, meta=meta)


@router.get("/workspace/presence", response_model=WorkspaceOfficePresenceOut)
def api_workspace_presence(
    year: int = Query(default=date.today().year),
    month: int | None = Query(default=None, ge=1, le=12),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> WorkspaceOfficePresenceOut:
    return get_workspace_office_presence(db, year=year, month=month, meta=meta)


@router.put("/workspace/bookings/toggle", response_model=WorkspaceBookingToggleOut)
def api_workspace_booking_toggle(
    data: WorkspaceBookingToggleIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> WorkspaceBookingToggleOut:
    return toggle_workspace_booking(db, data, meta)


@router.get("/workspace/places", response_model=list[WorkspacePlaceOut])
def api_workspace_places(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[WorkspacePlaceOut]:
    return list_workspace_places(db)


@router.post("/workspace/places", response_model=WorkspacePlaceOut)
def api_create_workspace_place(
    data: WorkspacePlaceIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> WorkspacePlaceOut:
    return create_workspace_place(db, data)


@router.patch("/workspace/places/{place_id}", response_model=WorkspacePlaceOut)
def api_update_workspace_place(
    place_id: int,
    data: WorkspacePlaceUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> WorkspacePlaceOut:
    return update_workspace_place(db, place_id, data)


@router.delete("/workspace/places/{place_id}")
def api_delete_workspace_place(
    place_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> dict[str, bool]:
    delete_workspace_place(db, place_id)
    return {"ok": True}


@router.get("/photos/{photo_path:path}")
def api_serve_photo(photo_path: str) -> Response:
    loaded = load_photo_content(photo_path)
    if loaded is None:
        raise HTTPException(status_code=404, detail="Фото не найдено.")
    body, content_type = loaded
    return Response(content=body, media_type=content_type)


profile_router = APIRouter(prefix="/api/profile", tags=["profile"])


@profile_router.get("", response_model=ProfileOut)
def api_profile(
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> ProfileOut:
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    return load_profile(
        db,
        org_user_id=org_user_id,
        app_login=meta.get("app_login"),
        app_role=meta.get("app_role") or "full",
    )


@profile_router.patch("", response_model=ProfileOut)
def api_update_profile(
    data: ProfileUpdateIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> ProfileOut:
    org_user_id = meta.get("org_user_id")
    if not org_user_id:
        raise HTTPException(status_code=400, detail="Редактирование профиля недоступно.")
    return update_profile(db, int(org_user_id), data)


@profile_router.post("/photo", response_model=ProfileOut)
async def api_profile_photo(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> ProfileOut:
    org_user_id = meta.get("org_user_id")
    if not org_user_id:
        raise HTTPException(status_code=400, detail="Загрузка фото недоступна.")
    return await update_profile_photo_service(db, int(org_user_id), file)


@profile_router.post("/password")
def api_change_password(
    data: PasswordChangeIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    change_password(db, org_user_id, meta.get("app_login"), data)
    return {"ok": True}


@profile_router.get("/office-days", response_model=list[OfficeDayOut])
def api_profile_office_days(
    year: int = Query(default=date.today().year),
    month: int = Query(default=date.today().month, ge=1, le=12),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> list[OfficeDayOut]:
    return get_profile_office_days(db, year=year, month=month, meta=meta)


@profile_router.put("/office-days/range", response_model=OfficeDayRangeOut)
def api_profile_office_days_range(
    data: OfficeDayRangeIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> OfficeDayRangeOut:
    return upsert_profile_office_days(db, data, meta)


users_router = APIRouter(prefix="/api/org/users", tags=["org-users"])


@users_router.get("", response_model=list[OrgUserOut])
def api_list_users(
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> list[OrgUserOut]:
    return list_org_users(db)


@users_router.post("", response_model=OrgUserOut)
def api_create_user(
    data: OrgUserIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> OrgUserOut:
    return create_org_user_account(db, data)


@users_router.patch("/{user_id}", response_model=OrgUserOut)
def api_update_user(
    user_id: int,
    data: OrgUserUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(require_org_admin),
) -> OrgUserOut:
    return update_org_user_account(db, user_id, data)
