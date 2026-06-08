import logging
from datetime import date

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy.orm import Session

from app.auth_service import login_with_app_user, login_with_pat
from app.auth_sessions import delete_session, get_session, get_session_meta
from app.boards import ALL_BOARDS_CODE, BOARDS, boards_for_sync
from app.config import settings
from app.db import ensure_auth_session_table, get_db
from app.models import SyncRun
from app.product_status_service import load_b2b_product_status
from app.product_status_presentation import generate_b2b_product_status_presentation
from app.report_service import export_csv, load_change_requests
from app.schemas import (
    AuthDefaultsOut,
    AuthLoginOut,
    BoardOut,
    DashboardOut,
    ProductStatusB2BOut,
    SyncRunOut,
    TfsAuthIn,
    TfsAuthStatusOut,
)
from app.sync_service import run_sync
from app.tfs_auth import TfsAuth, build_tfs_auth

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
def startup() -> None:
    ensure_auth_session_table()


def require_pat(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> str:
    auth = get_session(x_session_id)
    if auth is None or not auth.pat:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    return auth.pat


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
    auth = get_session(x_session_id)
    if auth is None:
        return TfsAuthStatusOut(authenticated=False)
    meta = get_session_meta(x_session_id)
    return TfsAuthStatusOut(
        authenticated=True,
        baseUrl=auth.base_url,
        project=auth.project,
        authMode=meta.get("auth_mode"),
        username=meta.get("app_login"),
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
    sort: str = Query(default="id_desc"),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    status: str | None = Query(default=None),
    quarter: str | None = Query(default=None),
    metric: str | None = Query(
        default=None,
        description="Фильтр таблицы: launching_soon, launched, errors",
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
        metric=metric,
    )


@app.get("/api/product-status/b2b", response_model=ProductStatusB2BOut)
def product_status_b2b() -> ProductStatusB2BOut:
    return load_b2b_product_status()


@app.get("/api/product-status/b2b/presentation")
def product_status_b2b_presentation() -> Response:
    content, filename = generate_b2b_product_status_presentation()
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export")
def export_report(
    db: Session = Depends(get_db),
    board: str | None = Query(default=None),
    _: str = Depends(require_pat),
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
) -> SyncRunOut:
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
