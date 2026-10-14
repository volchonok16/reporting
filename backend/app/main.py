import logging
from datetime import date
import asyncio

from fastapi import BackgroundTasks, Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.app_access import can_manage_org, has_planning_access, is_roadmap_role, is_superadmin_user, is_voice_only, sync_board_denied_reason
from app.app_page_service import get_user_allowed_page_keys, is_other_user_employee, sync_app_pages
from app.auth_service import login_with_app_user
from app.auth_sessions import (
    delete_all_sessions,
    delete_session,
    get_session,
    get_session_with_meta,
)
from app.maintenance import get_maintenance_state, set_maintenance_state
from app.boards import (
    ALL_BOARDS_CODE,
    boards_for_sync,
    boards_sharing_alias,
    default_board,
    ensure_boards_loaded,
    grouped_boards_for_ui,
    is_all_boards,
)
from app.config import settings
from app.db import close_db_session, ensure_startup_schema, get_db, purge_stale_b2b_audit_records
from app.org_models import OrgUser
from app.org_photo_service import photo_public_url
from app.org_service import get_employee_for_org_user
from app.models import AuthSession, SyncRun
from app.b2b_news_service import (
    delete_b2b_news_row,
    load_b2b_news,
    load_b2b_news_history,
    load_b2b_news_snapshots,
    restore_b2b_news_snapshot,
    save_b2b_news_to_db,
)
from app.revenue_activities_service import (
    delete_revenue_activity_row,
    load_revenue_activities,
    load_revenue_activities_history,
    load_revenue_activities_snapshots,
    restore_revenue_activity_snapshot,
    save_revenue_activities_to_db,
)
from app.gov_initiatives_service import (
    delete_gov_initiative_row,
    load_gov_initiatives,
    load_gov_initiatives_history,
    load_gov_initiatives_snapshots,
    restore_gov_initiative_snapshot,
    save_gov_initiatives_to_db,
)
from app.b2b_product_status_attachments import (
    delete_product_status_attachment,
    load_product_status_attachment_bytes,
    save_product_status_attachment,
)
from app.b2b_product_status_db import (
    delete_b2b_product_status_row,
    load_b2b_product_status_history,
    load_b2b_product_status_snapshots,
    restore_b2b_product_status_snapshot,
    save_b2b_product_status_to_db,
    get_b2b_product_status_office_access,
    set_b2b_product_status_office_access,
    set_b2b_product_status_office_editing_locked,
)
from app.product_status_service import load_b2b_product_status
from app.product_status_excel import generate_b2b_product_status_excel
from app.revenue_activities_excel import generate_revenue_activities_excel
from app.gov_initiatives_excel import generate_gov_initiatives_excel
from app.product_status_presentation import generate_b2b_product_status_presentation
from app.product_status_live import (
    WORKBOOK_B2B,
    WORKBOOK_B2B_NEWS,
    WORKBOOK_GOV_INITIATIVES,
    WORKBOOK_REVENUE_ACTIVITIES,
    gids_from_save_payload,
    notify_product_status_saved,
    set_main_event_loop as set_product_status_live_event_loop,
)
from app.product_status_live_routes import router as product_status_live_router
from app.report_service import XLSX_MEDIA_TYPE, export_xlsx, load_change_requests, load_change_requests_by_numbers
from app.product_service import load_products
from app.business_value_service import update_business_value
from app.roadmap_priority_service import update_roadmap_comment, update_roadmap_priority
from app.digital_plan_service import load_digital_plan, update_digital_plan_has_uc
from app.zni_external_data_service import update_zni_external_data
from app.schemas import (
    AuthDefaultsOut,
    AuthLoginOut,
    BoardOut,
    BusinessValueUpdateIn,
    RoadmapCommentUpdateIn,
    RoadmapPriorityUpdateIn,
    DigitalPlanOut,
    DigitalPlanUcUpdateIn,
    ZniExternalDataUpdateIn,
    ChangeRequestOut,
    DashboardOut,
    MaintenanceOut,
    MaintenanceUpdateIn,
    PasswordResetConfirmIn,
    PasswordResetOut,
    PasswordResetRequestIn,
    PasswordResetVerifyIn,
    ProductsOut,
    ProductStatusAttachmentOut,
    ProductStatusB2BOut,
    ProductStatusHistoryOut,
    ProductStatusOfficeAccessIn,
    ProductStatusOfficeAccessOut,
    ProductStatusOfficeEditingLockIn,
    ProductStatusOfficeMemberOut,
    ProductStatusSaveIn,
    ProductStatusSheetOut,
    ProductStatusSnapshotsOut,
    RevokeSessionsOut,
    SyncRunOut,
    TaskLookupIn,
    TaskLookupOut,
    TfsAuthIn,
    TfsAuthStatusOut,
    VoiceSsoTokenOut,
)
from app.password_reset import (
    PasswordResetError,
    confirm_password_reset,
    request_password_reset,
    verify_reset_code,
)
from app.voice_sso import issue_voice_sso_token
from app.sync_service import run_sync
from app.tfs_auth import TfsAuth
from app.org_routes import profile_router, router as org_router, users_router
from app.notification_routes import router as notification_router
from app.youjail_routes import router as youjail_router
from app.planning_routes import router as planning_router
from app.zni_category_routes import router as zni_category_router
from app.voice_integration import integrate_voice, start_voice_jobs, stop_voice_jobs

logger = logging.getLogger(__name__)

app = FastAPI(title="Reporting API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    from app.youjail_terminal import set_main_event_loop

    loop = asyncio.get_running_loop()
    set_main_event_loop(loop)
    set_product_status_live_event_loop(loop)
    ensure_startup_schema()
    integrate_voice(app)
    db = next(get_db())
    try:
        sync_app_pages(db)
        ensure_boards_loaded(db)
    finally:
        close_db_session(db)
    purge_stale_b2b_audit_records()
    start_voice_jobs()
    from app.status_office_schedule import start_status_office_schedule

    start_status_office_schedule()


@app.on_event("shutdown")
async def shutdown() -> None:
    stop_voice_jobs()
    from app.status_office_schedule import stop_status_office_schedule

    stop_status_office_schedule()


app.include_router(org_router)
app.include_router(profile_router)
app.include_router(users_router)
app.include_router(notification_router)
app.include_router(youjail_router)
app.include_router(product_status_live_router)
app.include_router(planning_router)
app.include_router(zni_category_router)


def _live_changed_by(meta: dict) -> str | None:
    login = meta.get("app_login")
    if isinstance(login, str) and login.strip():
        return login.strip()
    return None


def require_pat(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> str:
    auth = get_session(x_session_id)
    if auth is None or not auth.pat:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    return auth.pat


def require_session(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> None:
    if get_session(x_session_id) is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")


def require_full_app_access(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> None:
    _, meta = get_session_with_meta(x_session_id)
    if get_session(x_session_id) is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")


def require_org_manage_access(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> None:
    _, meta = get_session_with_meta(x_session_id)
    if get_session(x_session_id) is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    if not can_manage_org(meta):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")


def _can_sync_tfs(auth: TfsAuth | None, meta: dict) -> bool:
    if auth is None or not auth.pat:
        return False
    if meta.get("auth_mode") == "pat":
        return True
    return meta.get("org_user_role") in {"admin", "superadmin"}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/voice/sso-token", response_model=VoiceSsoTokenOut)
def voice_sso_token(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> VoiceSsoTokenOut:
    """Короткий SSO-токен для вкладки Voice (без второго логина)."""
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    login = (meta.get("app_login") or "").strip()
    if not login:
        login = "user@reporting.local"
    if "@" not in login:
        login = f"{login}@reporting.local"
    is_admin = meta.get("org_user_role") in {"admin", "superadmin"} or meta.get("auth_mode") == "pat"
    voice_admin = bool(meta.get("voice_admin"))
    if meta.get("org_user_id") is not None and not voice_admin:
        # Подтянуть актуальный флаг из БД (если сессия создана до назначения роли).
        db = next(get_db())
        try:
            org_user = db.get(OrgUser, int(meta["org_user_id"]))
            if org_user is not None:
                voice_admin = bool(getattr(org_user, "voice_admin", False))
        finally:
            close_db_session(db)
    # Voice-only и обычные пользователи получают полный функционал карусели;
    # суперюзер карусели — админы reporting; очистка мастер-файла — voice_admin.
    token = issue_voice_sso_token(
        email=login,
        is_admin=bool(is_admin),
        voice_admin=bool(voice_admin),
        display_name=login,
    )
    return VoiceSsoTokenOut(token=token, expiresIn=120)


def _maintenance_public_fields(db: Session) -> dict:
    state = get_maintenance_state(db)
    return {
        "maintenanceEnabled": state.enabled,
        "maintenanceMessage": state.public_message if state.enabled else (state.message or ""),
    }


@app.get("/api/auth/defaults", response_model=AuthDefaultsOut)
def auth_defaults(db: Session = Depends(get_db)) -> AuthDefaultsOut:
    boards = ensure_boards_loaded(db, refresh=True)
    board = default_board(boards)
    maint = _maintenance_public_fields(db)
    return AuthDefaultsOut(
        baseUrl=settings.tfs_base_url,
        project=board.project,
        projectId=board.project_id,
        maintenanceEnabled=maint["maintenanceEnabled"],
        maintenanceMessage=maint["maintenanceMessage"],
    )


@app.get("/api/auth/status", response_model=TfsAuthStatusOut)
def auth_status(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> TfsAuthStatusOut:
    db_maint = next(get_db())
    try:
        maint = _maintenance_public_fields(db_maint)
        state = get_maintenance_state(db_maint)
    finally:
        close_db_session(db_maint)

    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        return TfsAuthStatusOut(
            authenticated=False,
            maintenanceEnabled=maint["maintenanceEnabled"],
            maintenanceMessage=maint["maintenanceMessage"],
            maintenanceBlocked=bool(state.enabled),
        )
    app_role = meta.get("app_role") or "full"
    auth_mode = meta.get("auth_mode")
    voice_only_flag = is_voice_only(meta)
    superadmin_flag = is_superadmin_user(meta)
    can_unlock_product_status = superadmin_flag
    can_sync_tfs = False if (voice_only_flag and not superadmin_flag) else _can_sync_tfs(auth, meta)
    can_manage_org_flag = False if (voice_only_flag and not superadmin_flag) else can_manage_org(meta)
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    org_employee_id: int | None = None
    org_employee_name: str | None = None
    org_employee_photo_url: str | None = None
    must_change_password_flag = False
    other_user_flag = False
    page_access_restricted = False
    planning_access_flag = False
    allowed_page_keys: list[str] = []
    if org_user_id is not None:
        db = next(get_db())
        try:
            org_user = db.get(OrgUser, org_user_id)
            if org_user is not None:
                voice_only_flag = bool(org_user.voice_only) and not superadmin_flag
                must_change_password_flag = bool(
                    getattr(org_user, "must_change_password", False)
                )
                if voice_only_flag and not superadmin_flag:
                    can_sync_tfs = False
                    can_manage_org_flag = False
            emp = get_employee_for_org_user(db, org_user_id)
            if emp:
                org_employee_id = emp.id
                org_employee_name = emp.full_name
                org_employee_photo_url = photo_public_url(emp.photo_path)
                other_user_flag = is_other_user_employee(emp)
                allowed_page_keys = get_user_allowed_page_keys(db, org_user_id)
                page_access_restricted = (not superadmin_flag) and (
                    other_user_flag or any(key != "planning" for key in allowed_page_keys)
                )
                if not page_access_restricted:
                    allowed_page_keys = ["planning"] if "planning" in allowed_page_keys else []
            planning_access_flag = (
                True
                if superadmin_flag
                else (False if voice_only_flag else has_planning_access(db, meta))
            )
            if not can_unlock_product_status:
                from app.status_office_schedule import is_status_office_lead

                can_unlock_product_status = is_status_office_lead(db, meta)
        finally:
            close_db_session(db)
    else:
        planning_access_flag = can_manage_org_flag
    return TfsAuthStatusOut(
        authenticated=True,
        baseUrl=auth.base_url,
        project=auth.project,
        authMode=auth_mode,
        username=meta.get("app_login"),
        appRole=app_role,  # type: ignore[arg-type]
        canSyncTfs=can_sync_tfs,
        canManageOrg=can_manage_org_flag,
        isSuperAdmin=superadmin_flag,
        canUnlockProductStatus=can_unlock_product_status,
        voiceOnly=voice_only_flag and not superadmin_flag,
        otherUser=other_user_flag,
        pageAccessRestricted=page_access_restricted,
        planningAccess=planning_access_flag,
        allowedPageKeys=allowed_page_keys if page_access_restricted or other_user_flag else allowed_page_keys,
        orgUserId=org_user_id,
        orgEmployeeId=org_employee_id,
        orgEmployeeName=org_employee_name,
        orgEmployeePhotoUrl=org_employee_photo_url,
        mustChangePassword=must_change_password_flag,
        maintenanceEnabled=maint["maintenanceEnabled"],
        maintenanceMessage=maint["maintenanceMessage"],
        maintenanceBlocked=False,
    )


@app.post("/api/auth/login", response_model=AuthLoginOut)
async def auth_login(payload: TfsAuthIn) -> AuthLoginOut:
    if (payload.pat or "").strip():
        raise HTTPException(status_code=400, detail="Вход по PAT-токену отключён. Используйте логин и пароль.")

    username = (payload.username or "").strip()
    password = payload.password or ""

    if username and password:
        return await login_with_app_user(
            username=username,
            password=password,
            base_url=payload.baseUrl,
            project=payload.project,
            project_id=payload.projectId,
        )

    raise HTTPException(status_code=400, detail="Укажите логин и пароль.")


@app.post("/api/auth/password-reset/request", response_model=PasswordResetOut)
def auth_password_reset_request(payload: PasswordResetRequestIn, db: Session = Depends(get_db)) -> PasswordResetOut:
    try:
        message = request_password_reset(db, payload.email)
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    return PasswordResetOut(message=message)


@app.post("/api/auth/password-reset/verify", response_model=PasswordResetOut)
def auth_password_reset_verify(payload: PasswordResetVerifyIn, db: Session = Depends(get_db)) -> PasswordResetOut:
    try:
        verify_reset_code(db, email=payload.email, code=payload.code)
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    return PasswordResetOut(message="Код подтверждён.")


@app.post("/api/auth/password-reset/confirm", response_model=PasswordResetOut)
def auth_password_reset_confirm(payload: PasswordResetConfirmIn, db: Session = Depends(get_db)) -> PasswordResetOut:
    try:
        login = confirm_password_reset(
            db,
            email=payload.email,
            code=payload.code,
            new_login=payload.newLogin,
            new_password=payload.newPassword,
            new_password_repeat=payload.newPasswordRepeat,
        )
    except PasswordResetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    return PasswordResetOut(message=f"Логин и пароль сохранены. Войдите как {login}.")


@app.post("/api/auth/logout")
def auth_logout(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict[str, bool]:
    delete_session(x_session_id)
    return {"ok": True}


@app.get("/api/admin/maintenance", response_model=MaintenanceOut)
def get_admin_maintenance(
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> MaintenanceOut:
    state = get_maintenance_state(db)
    session_count = db.query(AuthSession).count()
    return MaintenanceOut(
        enabled=state.enabled,
        message=state.message,
        allowAdmin=state.allow_admin,
        updatedAt=state.updated_at,
        updatedByOrgUserId=state.updated_by_org_user_id,
        sessionCount=session_count,
    )


@app.patch("/api/admin/maintenance", response_model=MaintenanceOut)
def patch_admin_maintenance(
    payload: MaintenanceUpdateIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_org_manage_access),
) -> MaintenanceOut:
    _, meta = get_session_with_meta(x_session_id)
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    state = set_maintenance_state(
        db,
        enabled=payload.enabled,
        message=payload.message,
        allow_admin=payload.allowAdmin,
        updated_by_org_user_id=org_user_id,
    )
    if payload.revokeOtherSessions:
        delete_all_sessions(keep_session_id=x_session_id)
    session_count = db.query(AuthSession).count()
    return MaintenanceOut(
        enabled=state.enabled,
        message=state.message,
        allowAdmin=state.allow_admin,
        updatedAt=state.updated_at,
        updatedByOrgUserId=state.updated_by_org_user_id,
        sessionCount=session_count,
    )


@app.post("/api/admin/sessions/revoke-all", response_model=RevokeSessionsOut)
def revoke_all_sessions(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_org_manage_access),
    keepCurrent: bool = Query(default=True, description="Оставить сессию вызывающего администратора"),
) -> RevokeSessionsOut:
    keep_id = x_session_id if keepCurrent else None
    revoked = delete_all_sessions(keep_session_id=keep_id)
    return RevokeSessionsOut(revoked=revoked, keptCurrent=bool(keep_id))


@app.get("/api/boards", response_model=list[BoardOut])
def list_boards(db: Session = Depends(get_db)) -> list[BoardOut]:
    boards = ensure_boards_loaded(db, refresh=True)
    items = [
        BoardOut(
            code=ALL_BOARDS_CODE,
            name="Все доски",
            displayName="Все доски",
            project="",
            memberCodes=[ALL_BOARDS_CODE],
        ),
    ]
    for board in grouped_boards_for_ui(boards):
        members = [item.code for item in boards_sharing_alias(board, boards)]
        items.append(
            BoardOut(
                code=board.code,
                name=board.name,
                displayName=board.display_name,
                project=board.project,
                memberCodes=members,
            )
        )
    return items


@app.get("/api/dashboard", response_model=DashboardOut)
def dashboard(
    db: Session = Depends(get_db),
    board: str | None = Query(default=None),
    search: str | None = Query(default=None),
    sort: str = Query(default="planned_date_upcoming"),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    status: str | None = Query(default=None),
    quarter: str | None = Query(default=None),
    customer: list[str] = Query(
        default=[],
        description="Фильтр по заказчикам (ФИО); несколько значений — ИЛИ; __none__ — без заказчика",
    ),
    ect_reservation: str | None = Query(
        default=None,
        description="Фильтр брони ЕЦТ: yes или no",
    ),
    linked_environment: str | None = Query(
        default=None,
        description="Только Digital: yes — ЗНИ со связью CRM / Bercut / ESB",
    ),
    metric: str | None = Query(
        default=None,
        description="Фильтр таблицы: in_progress, launching_soon, launched, completed, errors",
    ),
    tag_group: list[str] = Query(
        default=[],
        description="Фильтр области (только Digital): newlk — ЛК b2b, site — Сайт",
    ),
) -> DashboardOut:
    return load_change_requests(
        db,
        board_code=board,
        search=search,
        sort=sort,
        date_from=date_from,
        date_to=date_to,
        status=status,
        quarter=quarter,
        customer=customer,
        ect_reservation=ect_reservation,
        linked_environment=linked_environment,
        metric=metric,
        tag_groups=tag_group,
    )


@app.get("/api/products", response_model=ProductsOut)
def products(
    db: Session = Depends(get_db),
    hide_closed: bool = Query(default=True, alias="hideClosed"),
) -> ProductsOut:
    return load_products(db, hide_closed=hide_closed)


@app.post("/api/tasks/lookup", response_model=TaskLookupOut)
def tasks_lookup(
    payload: TaskLookupIn,
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> TaskLookupOut:
    return TaskLookupOut(items=load_change_requests_by_numbers(db, payload.numbers))


@app.patch("/api/tasks/{external_id}/business-value", response_model=ChangeRequestOut)
async def patch_business_value(
    external_id: str,
    payload: BusinessValueUpdateIn,
    db: Session = Depends(get_db),
    pat: str = Depends(require_pat),
    _: None = Depends(require_full_app_access),
) -> ChangeRequestOut:
    try:
        await update_business_value(
            db,
            pat=pat,
            external_id=external_id,
            value=payload.value,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    dashboard = load_change_requests(db, board_code=ALL_BOARDS_CODE, search=external_id)
    item = next((row for row in dashboard.items if row.number == external_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="ЗНИ не найден после обновления")
    return item


@app.get("/api/digital-plan", response_model=DigitalPlanOut)
def digital_plan(
    db: Session = Depends(get_db),
    _: None = Depends(require_session),
    year: int = Query(default=2026, ge=2020, le=2100),
    plan_tag: str = Query(default="Q3-Q4'26"),
) -> DigitalPlanOut:
    try:
        return load_digital_plan(db, plan_tag=plan_tag, year=year)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/tasks/{external_id}/digital-plan-uc", response_model=ChangeRequestOut)
def patch_digital_plan_uc(
    external_id: str,
    payload: DigitalPlanUcUpdateIn,
    db: Session = Depends(get_db),
    _: None = Depends(require_session),
) -> ChangeRequestOut:
    try:
        update_digital_plan_has_uc(
            db,
            external_id=external_id,
            has_uc=payload.hasUc,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    dashboard = load_change_requests(db, board_code=ALL_BOARDS_CODE, search=external_id)
    item = next((row for row in dashboard.items if row.number == external_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="ЗНИ не найден после обновления")
    return item


@app.patch("/api/tasks/{external_id}/external-data", response_model=ChangeRequestOut)
def patch_zni_external_data(
    external_id: str,
    payload: ZniExternalDataUpdateIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> ChangeRequestOut:
    _, meta = get_session_with_meta(x_session_id)
    if get_session(x_session_id) is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    fields = payload.model_fields_set
    try:
        update_zni_external_data(
            db,
            external_id=external_id,
            priority=payload.priority,
            set_priority="priority" in fields,
            commercial_effect=payload.commercialEffect,
            set_commercial_effect="commercialEffect" in fields,
            actual_period=payload.actualPeriod,
            set_actual_period="actualPeriod" in fields,
            desired_date=payload.desiredDate,
            set_desired_date="desiredDate" in fields,
            comment=payload.comment,
            set_comment="comment" in fields,
            category_id=payload.categoryId,
            set_category_id="categoryId" in fields,
            can_manage_org=can_manage_org(meta),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    dashboard = load_change_requests(db, board_code=ALL_BOARDS_CODE, search=external_id)
    item = next((row for row in dashboard.items if row.number == external_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="ЗНИ не найден после обновления")
    return item


@app.patch("/api/tasks/{external_id}/roadmap-priority", response_model=ChangeRequestOut)
def patch_roadmap_priority(
    external_id: str,
    payload: RoadmapPriorityUpdateIn,
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> ChangeRequestOut:
    try:
        update_roadmap_priority(
            db,
            external_id=external_id,
            priority=payload.priority,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    dashboard = load_change_requests(db, board_code=ALL_BOARDS_CODE, search=external_id)
    item = next((row for row in dashboard.items if row.number == external_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="ЗНИ не найден после обновления")
    return item


@app.patch("/api/tasks/{external_id}/roadmap-comment", response_model=ChangeRequestOut)
def patch_roadmap_comment(
    external_id: str,
    payload: RoadmapCommentUpdateIn,
    db: Session = Depends(get_db),
    _: None = Depends(require_session),
) -> ChangeRequestOut:
    try:
        update_roadmap_comment(
            db,
            external_id=external_id,
            comment=payload.comment,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    dashboard = load_change_requests(db, board_code=ALL_BOARDS_CODE, search=external_id)
    item = next((row for row in dashboard.items if row.number == external_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="ЗНИ не найден после обновления")
    return item


@app.get("/api/product-status/b2b", response_model=ProductStatusB2BOut)
def product_status_b2b(
    db: Session = Depends(get_db),
    gid: str | None = Query(default=None),
    meta_only: bool = Query(default=False),
    refresh: bool = Query(default=False),
    _: None = Depends(require_full_app_access),
) -> ProductStatusB2BOut:
    del refresh
    return load_b2b_product_status(
        db=db,
        gid=gid,
        meta_only=meta_only,
    )


@app.get("/api/product-status/b2b/presentation")
def product_status_b2b_presentation(
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_b2b_product_status_presentation(
        load_b2b_product_status(db=db),
        db=db,
    )
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/product-status/b2b/excel")
def product_status_b2b_excel(
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_b2b_product_status_excel(load_b2b_product_status(db=db))
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/product-status/b2b/excel")
def product_status_b2b_excel_from_payload(
    payload: ProductStatusB2BOut,
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_b2b_product_status_excel(payload)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/product-status/b2b/presentation")
def product_status_b2b_presentation_from_payload(
    payload: ProductStatusB2BOut,
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_b2b_product_status_presentation(payload)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/product-status/b2b/save")
def product_status_b2b_save(
    payload: ProductStatusSaveIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_b2b_product_status_to_db(db, payload, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B,
        gids=gids_from_save_payload(payload),
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.patch(
    "/api/product-status/b2b/offices/{gid}/editing-lock",
    response_model=ProductStatusSheetOut,
)
def product_status_b2b_office_editing_lock(
    gid: str,
    payload: ProductStatusOfficeEditingLockIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> ProductStatusSheetOut:
    _, meta = get_session_with_meta(x_session_id)
    from app.status_office_schedule import is_status_office_lead

    if payload.locked:
        if not is_superadmin_user(meta):
            raise HTTPException(
                status_code=403,
                detail="Блокировать офис может только суперадминистратор.",
            )
    elif not is_superadmin_user(meta) and not is_status_office_lead(db, meta):
        raise HTTPException(
            status_code=403,
            detail="Снять блокировку может суперадминистратор или руководитель.",
        )
    sheet = set_b2b_product_status_office_editing_locked(
        db,
        gid=gid,
        locked=payload.locked,
    )
    from app.status_office_schedule import send_office_lock_notice_by_gid

    send_office_lock_notice_by_gid(db, gid=gid, locked=payload.locked)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return sheet


def _office_access_out(payload: dict) -> ProductStatusOfficeAccessOut:
    return ProductStatusOfficeAccessOut(
        gid=str(payload["gid"]),
        name=str(payload["name"]),
        autoLockEnabled=bool(payload["autoLockEnabled"]),
        members=[
            ProductStatusOfficeMemberOut(
                employeeId=int(item["employee_id"]),
                fullName=str(item["full_name"]),
                email=item.get("email"),
            )
            for item in payload.get("members") or []
        ],
    )


@app.get(
    "/api/product-status/b2b/offices/{gid}/access",
    response_model=ProductStatusOfficeAccessOut,
)
def product_status_b2b_office_access(
    gid: str,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_full_app_access),
) -> ProductStatusOfficeAccessOut:
    _, meta = get_session_with_meta(x_session_id)
    if not is_superadmin_user(meta):
        raise HTTPException(status_code=403, detail="Состав офиса меняет только суперадминистратор.")
    return _office_access_out(get_b2b_product_status_office_access(db, gid=gid))


@app.put(
    "/api/product-status/b2b/offices/{gid}/access",
    response_model=ProductStatusOfficeAccessOut,
)
def product_status_b2b_office_access_save(
    gid: str,
    payload: ProductStatusOfficeAccessIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> ProductStatusOfficeAccessOut:
    _, meta = get_session_with_meta(x_session_id)
    if not is_superadmin_user(meta):
        raise HTTPException(status_code=403, detail="Состав офиса меняет только суперадминистратор.")
    saved = set_b2b_product_status_office_access(
        db,
        gid=gid,
        auto_lock_enabled=payload.autoLockEnabled,
        employee_ids=payload.employeeIds,
    )
    if saved.get("unlockedNow"):
        from app.status_office_schedule import send_office_lock_notice_by_gid

        send_office_lock_notice_by_gid(db, gid=gid, locked=False)
        notify_product_status_saved(
            workbook=WORKBOOK_B2B,
            gids=[gid],
            changed_by=_live_changed_by(meta),
            origin_connection_id=x_live_connection_id,
        )
    return _office_access_out(saved)


@app.delete("/api/product-status/b2b/rows/{row_id}")
def product_status_b2b_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_b2b_product_status_row(db, gid=gid, row_id=row_id, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.post(
    "/api/product-status/b2b/rows/{row_id}/attachments",
    response_model=ProductStatusAttachmentOut,
)
async def product_status_b2b_upload_attachment(
    row_id: int,
    gid: str = Query(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> ProductStatusAttachmentOut:
    _, meta = get_session_with_meta(x_session_id)
    payload = await save_product_status_attachment(
        db,
        row_id=row_id,
        gid=gid,
        file=file,
        meta=meta,
    )
    notify_product_status_saved(
        workbook=WORKBOOK_B2B,
        gids=[gid, "summary"],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return ProductStatusAttachmentOut(**payload)


@app.get("/api/product-status/b2b/attachments/{attachment_id}/download")
def product_status_b2b_download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_full_app_access),
) -> Response:
    from urllib.parse import quote

    _, meta = get_session_with_meta(x_session_id)
    body, filename, content_type = load_product_status_attachment_bytes(
        db,
        attachment_id=attachment_id,
        meta=meta,
    )
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "file"
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{ascii_name}"; '
            f"filename*=UTF-8''{quote(filename)}"
        ),
    }
    return Response(content=body, media_type=content_type, headers=headers)


@app.delete("/api/product-status/b2b/attachments/{attachment_id}")
def product_status_b2b_delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    result = delete_product_status_attachment(db, attachment_id=attachment_id, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B,
        gids=[str(result["gid"]), "summary"],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/product-status/b2b/history", response_model=ProductStatusHistoryOut)
def product_status_b2b_history(
    gid: str = Query(...),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> ProductStatusHistoryOut:
    return load_b2b_product_status_history(db, gid=gid, limit=limit)


@app.get("/api/product-status/b2b/snapshots", response_model=ProductStatusSnapshotsOut)
def product_status_b2b_snapshots(
    gid: str = Query(...),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> ProductStatusSnapshotsOut:
    return load_b2b_product_status_snapshots(db, gid=gid, limit=limit)


@app.post("/api/product-status/b2b/snapshots/{snapshot_id}/restore")
def product_status_b2b_restore_snapshot(
    snapshot_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_org_manage_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_b2b_product_status_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/b2b-news", response_model=ProductStatusB2BOut)
def b2b_news(
    gid: str | None = Query(default=None),
    meta_only: bool = Query(default=False),
    refresh: bool = Query(default=False),
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> ProductStatusB2BOut:
    del refresh
    return load_b2b_news(
        db=db,
        gid=gid,
        meta_only=meta_only,
    )


@app.post("/api/b2b-news/save")
def b2b_news_save(
    payload: ProductStatusSaveIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_b2b_news_to_db(db, payload, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B_NEWS,
        gids=gids_from_save_payload(payload),
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.delete("/api/b2b-news/rows/{row_id}")
def b2b_news_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_b2b_news_row(db, gid=gid, row_id=row_id, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B_NEWS,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/b2b-news/history", response_model=ProductStatusHistoryOut)
def b2b_news_history(
    gid: str = Query(...),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> ProductStatusHistoryOut:
    return load_b2b_news_history(db, gid=gid, limit=limit)


@app.get("/api/b2b-news/snapshots", response_model=ProductStatusSnapshotsOut)
def b2b_news_snapshots(
    gid: str = Query(...),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> ProductStatusSnapshotsOut:
    return load_b2b_news_snapshots(db, gid=gid, limit=limit)


@app.post("/api/b2b-news/snapshots/{snapshot_id}/restore")
def b2b_news_restore_snapshot(
    snapshot_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_b2b_news_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_B2B_NEWS,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/revenue-activities", response_model=ProductStatusB2BOut)
def revenue_activities(
    gid: str | None = Query(default=None),
    meta_only: bool = Query(default=False),
    refresh: bool = Query(default=False),
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> ProductStatusB2BOut:
    del refresh
    return load_revenue_activities(
        db=db,
        gid=gid,
        meta_only=meta_only,
    )


@app.get("/api/revenue-activities/excel")
def revenue_activities_excel(
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_revenue_activities_excel(load_revenue_activities(db=db))
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/revenue-activities/excel")
def revenue_activities_excel_from_payload(
    payload: ProductStatusB2BOut,
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_revenue_activities_excel(payload)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/revenue-activities/save")
def revenue_activities_save(
    payload: ProductStatusSaveIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_revenue_activities_to_db(db, payload, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_REVENUE_ACTIVITIES,
        gids=gids_from_save_payload(payload),
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.delete("/api/revenue-activities/rows/{row_id}")
def revenue_activities_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_revenue_activity_row(db, gid=gid, row_id=row_id, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_REVENUE_ACTIVITIES,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/revenue-activities/history", response_model=ProductStatusHistoryOut)
def revenue_activities_history(
    gid: str = Query(...),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> ProductStatusHistoryOut:
    return load_revenue_activities_history(db, gid=gid, limit=limit)


@app.get("/api/revenue-activities/snapshots", response_model=ProductStatusSnapshotsOut)
def revenue_activities_snapshots(
    gid: str = Query(...),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> ProductStatusSnapshotsOut:
    return load_revenue_activities_snapshots(db, gid=gid, limit=limit)


@app.post("/api/revenue-activities/snapshots/{snapshot_id}/restore")
def revenue_activities_restore_snapshot(
    snapshot_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_org_manage_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_revenue_activity_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_REVENUE_ACTIVITIES,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/gov-initiatives", response_model=ProductStatusB2BOut)
def gov_initiatives(
    gid: str | None = Query(default=None),
    meta_only: bool = Query(default=False),
    refresh: bool = Query(default=False),
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> ProductStatusB2BOut:
    del refresh
    return load_gov_initiatives(
        db=db,
        gid=gid,
        meta_only=meta_only,
    )


@app.get("/api/gov-initiatives/excel")
def gov_initiatives_excel(
    db: Session = Depends(get_db),
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_gov_initiatives_excel(load_gov_initiatives(db=db))
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/gov-initiatives/excel")
def gov_initiatives_excel_from_payload(
    payload: ProductStatusB2BOut,
    _: None = Depends(require_full_app_access),
) -> Response:
    content, filename = generate_gov_initiatives_excel(payload)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/gov-initiatives/save")
def gov_initiatives_save(
    payload: ProductStatusSaveIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_gov_initiatives_to_db(db, payload, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_GOV_INITIATIVES,
        gids=gids_from_save_payload(payload),
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.delete("/api/gov-initiatives/rows/{row_id}")
def gov_initiatives_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_gov_initiative_row(db, gid=gid, row_id=row_id, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_GOV_INITIATIVES,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/gov-initiatives/history", response_model=ProductStatusHistoryOut)
def gov_initiatives_history(
    gid: str = Query(...),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> ProductStatusHistoryOut:
    return load_gov_initiatives_history(db, gid=gid, limit=limit)


@app.get("/api/gov-initiatives/snapshots", response_model=ProductStatusSnapshotsOut)
def gov_initiatives_snapshots(
    gid: str = Query(...),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: None = Depends(require_org_manage_access),
) -> ProductStatusSnapshotsOut:
    return load_gov_initiatives_snapshots(db, gid=gid, limit=limit)


@app.post("/api/gov-initiatives/snapshots/{snapshot_id}/restore")
def gov_initiatives_restore_snapshot(
    snapshot_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    x_live_connection_id: str | None = Header(default=None, alias="X-Live-Connection-Id"),
    _: None = Depends(require_org_manage_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_gov_initiative_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
    notify_product_status_saved(
        workbook=WORKBOOK_GOV_INITIATIVES,
        gids=[gid],
        changed_by=_live_changed_by(meta),
        origin_connection_id=x_live_connection_id,
    )
    return {"status": "ok"}


@app.get("/api/export")
def export_report(
    db: Session = Depends(get_db),
    board: str | None = Query(default=None),
    _: str = Depends(require_pat),
    __: None = Depends(require_full_app_access),
) -> Response:
    content, filename = export_xlsx(db, board_code=board)
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _run_sync_background(sync_run_id: int, pat: str, board_code: str | None) -> None:
    try:
        await run_sync(pat, sync_run_id=sync_run_id, board_code=board_code)
    except Exception:
        logger.exception("background_sync_failed id=%s", sync_run_id)


@app.post("/api/sync", response_model=SyncRunOut)
async def start_sync(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    pat: str = Depends(require_pat),
    board: str | None = Query(default=None),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> SyncRunOut:
    _, meta = get_session_with_meta(x_session_id)
    if not _can_sync_tfs(get_session(x_session_id), meta):
        raise HTTPException(status_code=403, detail="Недостаточно прав для обновления из TFS.")
    denied = sync_board_denied_reason(meta.get("app_role"), board)
    if denied:
        raise HTTPException(status_code=403, detail=denied)
    if is_roadmap_role(meta.get("app_role")) and not board:
        raise HTTPException(
            status_code=400,
            detail="Укажите доску digital_streams_b2b для синхронизации.",
        )
    from app.models import SourceSystem

    tfs = db.query(SourceSystem).filter(SourceSystem.code == "tfs").first()
    if tfs is None:
        raise HTTPException(status_code=500, detail="source_system tfs not found")

    loaded = ensure_boards_loaded(db, refresh=True)
    target_boards = boards_for_sync(board, loaded)
    if board and not is_all_boards(board) and not target_boards:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Доска «{board}» не найдена среди активных записей zni_board. "
                "Проверьте code и is_active."
            ),
        )
    sync_run = SyncRun(
        source_system_id=tfs.id,
        status="running",
        parameters_json={"boards": [b.code for b in target_boards], "progress": "Старт…"},
    )
    db.add(sync_run)
    db.commit()
    db.refresh(sync_run)

    background_tasks.add_task(_run_sync_background, sync_run.id, pat, board)
    return SyncRunOut(
        id=sync_run.id,
        status=sync_run.status,
        progressMessage="Старт…",
        startedAt=sync_run.started_at,
    )


@app.get("/api/sync/{sync_id}", response_model=SyncRunOut)
def sync_status(sync_id: int, db: Session = Depends(get_db)) -> SyncRunOut:
    sync_run = db.get(SyncRun, sync_id)
    if sync_run is None:
        raise HTTPException(status_code=404, detail="Sync run not found")
    params = sync_run.parameters_json if isinstance(sync_run.parameters_json, dict) else {}
    return SyncRunOut(
        id=sync_run.id,
        status=sync_run.status,
        recordsFetched=sync_run.records_fetched,
        recordsUpserted=sync_run.records_upserted,
        errorMessage=sync_run.error_message,
        progressMessage=params.get("progress"),
        startedAt=sync_run.started_at,
        finishedAt=sync_run.finished_at,
    )
