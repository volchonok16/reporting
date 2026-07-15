import logging
from datetime import date
import asyncio

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy.orm import Session

from app.app_access import can_manage_org, is_roadmap_role, sync_board_denied_reason
from app.auth_service import login_with_app_user, login_with_pat
from app.auth_sessions import delete_session, get_session, get_session_with_meta
from app.boards import ALL_BOARDS_CODE, BOARDS, boards_for_sync
from app.config import settings
from app.db import close_db_session, ensure_startup_schema, get_db, purge_stale_b2b_audit_records
from app.org_photo_service import photo_public_url
from app.org_service import get_employee_for_org_user
from app.models import SyncRun
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
from app.b2b_product_status_db import (
    delete_b2b_product_status_row,
    load_b2b_product_status_history,
    load_b2b_product_status_snapshots,
    restore_b2b_product_status_snapshot,
    save_b2b_product_status_to_db,
)
from app.product_status_service import load_b2b_product_status
from app.product_status_excel import generate_b2b_product_status_excel
from app.product_status_presentation import generate_b2b_product_status_presentation
from app.report_service import export_csv, load_change_requests, load_change_requests_by_numbers
from app.business_value_service import update_business_value
from app.roadmap_priority_service import update_roadmap_comment, update_roadmap_priority
from app.digital_plan_service import load_digital_plan, update_digital_plan_has_uc
from app.schemas import (
    AuthDefaultsOut,
    AuthLoginOut,
    BoardOut,
    BusinessValueUpdateIn,
    RoadmapCommentUpdateIn,
    RoadmapPriorityUpdateIn,
    DigitalPlanOut,
    DigitalPlanUcUpdateIn,
    ChangeRequestOut,
    DashboardOut,
    ProductStatusB2BOut,
    ProductStatusHistoryOut,
    ProductStatusSaveIn,
    ProductStatusSnapshotsOut,
    SyncRunOut,
    TaskLookupIn,
    TaskLookupOut,
    TfsAuthIn,
    TfsAuthStatusOut,
)
from app.sync_service import run_sync
from app.tfs_auth import TfsAuth, build_tfs_auth
from app.org_routes import profile_router, router as org_router, users_router
from app.youjail_routes import router as youjail_router

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

    set_main_event_loop(asyncio.get_running_loop())
    ensure_startup_schema()
    purge_stale_b2b_audit_records()


app.include_router(org_router)
app.include_router(profile_router)
app.include_router(users_router)
app.include_router(youjail_router)


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
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")


def require_org_manage_access(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> None:
    _, meta = get_session_with_meta(x_session_id)
    if get_session(x_session_id) is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    if not can_manage_org(meta):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")


def _can_sync_tfs(auth: TfsAuth | None, meta: dict) -> bool:
    if auth is None or not auth.pat:
        return False
    if meta.get("auth_mode") == "pat":
        return True
    return meta.get("org_user_role") == "admin"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/auth/defaults", response_model=AuthDefaultsOut)
def auth_defaults() -> AuthDefaultsOut:
    board = BOARDS[0]
    return AuthDefaultsOut(
        baseUrl=settings.tfs_base_url,
        project=board.project,
        projectId=board.project_id,
    )


@app.get("/api/auth/status", response_model=TfsAuthStatusOut)
def auth_status(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> TfsAuthStatusOut:
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        return TfsAuthStatusOut(authenticated=False)
    app_role = meta.get("app_role") or "full"
    auth_mode = meta.get("auth_mode")
    can_sync_tfs = _can_sync_tfs(auth, meta)
    can_manage_org_flag = can_manage_org(meta)
    org_user_id = int(meta["org_user_id"]) if meta.get("org_user_id") else None
    org_employee_id: int | None = None
    org_employee_name: str | None = None
    org_employee_photo_url: str | None = None
    if org_user_id is not None:
        db = next(get_db())
        try:
            emp = get_employee_for_org_user(db, org_user_id)
            if emp:
                org_employee_id = emp.id
                org_employee_name = emp.full_name
                org_employee_photo_url = photo_public_url(emp.photo_path)
        finally:
            close_db_session(db)
    return TfsAuthStatusOut(
        authenticated=True,
        baseUrl=auth.base_url,
        project=auth.project,
        authMode=auth_mode,
        username=meta.get("app_login"),
        appRole=app_role,  # type: ignore[arg-type]
        canSyncTfs=can_sync_tfs,
        canManageOrg=can_manage_org_flag,
        orgUserId=org_user_id,
        orgEmployeeId=org_employee_id,
        orgEmployeeName=org_employee_name,
        orgEmployeePhotoUrl=org_employee_photo_url,
    )


@app.post("/api/auth/login", response_model=AuthLoginOut)
async def auth_login(payload: TfsAuthIn) -> AuthLoginOut:
    pat = (payload.pat or "").strip()
    username = (payload.username or "").strip()
    password = payload.password or ""

    if pat:
        auth = build_tfs_auth(
            base_url=payload.baseUrl,
            project=payload.project,
            project_id=payload.projectId,
            pat=pat,
        )
        return await login_with_pat(auth)

    if username and password:
        return await login_with_app_user(
            username=username,
            password=password,
            base_url=payload.baseUrl,
            project=payload.project,
            project_id=payload.projectId,
        )

    raise HTTPException(status_code=400, detail="Укажите PAT-токен или логин и пароль.")


@app.post("/api/auth/logout")
def auth_logout(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict[str, bool]:
    delete_session(x_session_id)
    return {"ok": True}


@app.get("/api/boards", response_model=list[BoardOut])
def list_boards() -> list[BoardOut]:
    items = [
        BoardOut(code=ALL_BOARDS_CODE, name="Все доски", displayName="Все доски", project=""),
    ]
    items.extend(
        BoardOut(code=b.code, name=b.name, displayName=b.display_name, project=b.project) for b in BOARDS
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
        ect_reservation=ect_reservation,
        linked_environment=linked_environment,
        metric=metric,
        tag_groups=tag_group,
    )


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
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_b2b_product_status_to_db(db, payload, meta=meta)
    return {"status": "ok"}


@app.delete("/api/product-status/b2b/rows/{row_id}")
def product_status_b2b_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_b2b_product_status_row(db, gid=gid, row_id=row_id, meta=meta)
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
    _: None = Depends(require_org_manage_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_b2b_product_status_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
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
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_b2b_news_to_db(db, payload, meta=meta)
    return {"status": "ok"}


@app.delete("/api/b2b-news/rows/{row_id}")
def b2b_news_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_b2b_news_row(db, gid=gid, row_id=row_id, meta=meta)
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
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_b2b_news_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
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


@app.post("/api/revenue-activities/save")
def revenue_activities_save(
    payload: ProductStatusSaveIn,
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    save_revenue_activities_to_db(db, payload, meta=meta)
    return {"status": "ok"}


@app.delete("/api/revenue-activities/rows/{row_id}")
def revenue_activities_delete_row(
    row_id: int,
    gid: str = Query(...),
    db: Session = Depends(get_db),
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
    _: None = Depends(require_full_app_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    delete_revenue_activity_row(db, gid=gid, row_id=row_id, meta=meta)
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
    _: None = Depends(require_org_manage_access),
) -> dict[str, str]:
    _, meta = get_session_with_meta(x_session_id)
    restore_revenue_activity_snapshot(db, snapshot_id=snapshot_id, gid=gid, meta=meta)
    return {"status": "ok"}


@app.get("/api/export")
def export_report(
    db: Session = Depends(get_db),
    board: str | None = Query(default=None),
    _: str = Depends(require_pat),
    __: None = Depends(require_full_app_access),
) -> PlainTextResponse:
    content = export_csv(db, board_code=board)
    return PlainTextResponse(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="zni-report.csv"'},
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

    target_boards = boards_for_sync(board)
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
