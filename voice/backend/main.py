from __future__ import annotations

import math
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Header, Query, Request, UploadFile
from starlette.background import BackgroundTask
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .auth import AuthService, AuthUser
from .config import settings
from .errors import AppError
from .importers import importer_for
from .jobs import JobService
from .master import MasterService
from .master_lock import MasterLockService
from .mapping_index import MappingIndexService
from .models import (
    ConvertRequest,
    DeleteARequest,
    DeleteBRequest,
    InspectRequest,
    LoginRequest,
    MasterBatchDeleteARequest,
    MasterBatchDeleteBRequest,
    MasterScopedBatchDeleteBRequest,
    MasterImportAnalyzeRequest,
    MasterLockNotificationRequest,
    MasterMergeRequest,
    MasterRecordRequest,
    MappingOptionsRequest,
    PasswordChangeRequest,
    UserCreateRequest,
    UserUpdateRequest,
)
from .security import validate_session_id
from .storage import (
    JobRecord,
    Registry,
    TERMINAL_STATUSES,
    UploadRecord,
    UploadService,
    opaque_id,
)
from .validation import ValidationService


registry = Registry(settings)
auth_service = AuthService(settings, registry)
upload_service = UploadService(settings, registry)
job_service = JobService(settings, registry)
validation_service = ValidationService(settings.preview_limit)
mapping_index_service = MappingIndexService(validation_service)
master_service = MasterService(settings, registry, validation_service)
master_lock_service = MasterLockService(registry)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    job_service.start()
    try:
        yield
    finally:
        job_service.shutdown()


app = FastAPI(
    title="A/B Mapping API",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type", "X-Session-ID"],
    expose_headers=["Content-Disposition"],
)


@app.exception_handler(AppError)
async def app_error_handler(_request: Request, error: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"detail": error.detail},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _request: Request, error: RequestValidationError
) -> JSONResponse:
    first = error.errors()[0] if error.errors() else {}
    location = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
    message = "Некорректный запрос"
    if location:
        message = f"Некорректное поле: {location}"
    return JSONResponse(
        status_code=422,
        content={"detail": {"code": "INVALID_REQUEST", "message": message}},
    )


def authorization_token(
    authorization: Annotated[
        str | None,
        Header(alias="Authorization"),
    ] = None,
) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise AppError(
            "AUTH_REQUIRED",
            "Необходимо войти в приложение",
            status_code=401,
        )
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise AppError(
            "AUTH_REQUIRED",
            "Необходимо войти в приложение",
            status_code=401,
        )
    return token


AuthToken = Annotated[str, Depends(authorization_token)]


def auth_dependency(token: AuthToken) -> AuthUser:
    return auth_service.authenticate(token)


CurrentUser = Annotated[AuthUser, Depends(auth_dependency)]


def session_dependency(
    _user: CurrentUser,
    x_session_id: Annotated[str | None, Header(alias="X-Session-ID")] = None,
) -> str:
    return validate_session_id(x_session_id)


SessionId = Annotated[str, Depends(session_dependency)]


def master_session_dependency(
    session_id: SessionId,
    user: CurrentUser,
) -> str:
    if not user.is_superuser and not user.can_access_master:
        raise AppError(
            "MASTER_ACCESS_DENIED",
            "Нет разрешения на просмотр мастер-файла",
            status_code=403,
        )
    return session_id


MasterSessionId = Annotated[str, Depends(master_session_dependency)]


def master_action_session_dependency(
    session_id: MasterSessionId,
    user: CurrentUser,
    token: AuthToken,
) -> str:
    master_lock_service.require_owner(user, token)
    return session_id


MasterActionSessionId = Annotated[
    str,
    Depends(master_action_session_dependency),
]


def superuser_dependency(user: CurrentUser) -> AuthUser:
    if not user.is_superuser:
        raise AppError(
            "SUPERUSER_REQUIRED",
            "Действие доступно только суперюзеру",
            status_code=403,
        )
    return user


Superuser = Annotated[AuthUser, Depends(superuser_dependency)]


def job_payload(job: JobRecord) -> dict[str, Any]:
    return {
        "id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": job.progress,
        "processedRows": job.processed_rows,
        "totalRows": job.total_rows,
        "error": job.error,
        "summary": job.summary,
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(body: LoginRequest) -> dict[str, Any]:
    return auth_service.login(body.email, body.password)


@app.get("/api/auth/me")
def current_user(user: CurrentUser) -> dict[str, Any]:
    return {"user": user.payload()}


@app.post("/api/auth/logout")
def logout(token: AuthToken, _user: CurrentUser) -> dict[str, bool]:
    auth_service.logout(token)
    return {"ok": True}


@app.post("/api/auth/change-password")
def change_password(
    body: PasswordChangeRequest,
    token: AuthToken,
    user: CurrentUser,
) -> dict[str, bool]:
    auth_service.change_password(user, body, token)
    return {"ok": True}


@app.get("/api/auth/users")
def list_users(_user: Superuser) -> dict[str, Any]:
    return {"items": auth_service.list_users()}


@app.post("/api/auth/users", status_code=201)
def create_user(
    body: UserCreateRequest,
    _user: Superuser,
) -> dict[str, Any]:
    return {"user": auth_service.create_user(body)}


@app.put("/api/auth/users/{user_id}")
def update_user(
    user_id: str,
    body: UserUpdateRequest,
    user: Superuser,
) -> dict[str, Any]:
    return {
        "user": auth_service.update_user(
            user_id,
            body,
            actor_id=user.id,
        )
    }


@app.get("/api/master/records")
def list_master_records(
    session_id: MasterSessionId,
    query: str = "",
    parameterGroup: Annotated[list[str] | None, Query()] = None,
    region: Annotated[list[int] | None, Query()] = None,
    sort: str = "base",
    duplicatesOnly: bool = False,
    invalidOnly: bool = False,
    invalidStartOnly: bool = False,
    offset: int = 0,
    limit: int = 200,
) -> dict[str, Any]:
    del session_id
    if offset < 0 or limit < 1 or limit > 500:
        raise AppError(
            "INVALID_PAGINATION",
            "Некорректные параметры страницы",
        )
    return master_service.list_records(
        query=query,
        parameter_groups=parameterGroup or (),
        regions=region or (),
        sort=sort,
        duplicates_only=duplicatesOnly,
        invalid_only=invalidOnly,
        invalid_start_only=invalidStartOnly,
        offset=offset,
        limit=limit,
    )


@app.get("/api/master/lock")
def master_lock_status(
    _session_id: MasterSessionId,
    user: CurrentUser,
    token: AuthToken,
) -> dict[str, Any]:
    return master_lock_service.status(user, token)


@app.post("/api/master/lock")
def acquire_master_lock(
    _session_id: MasterSessionId,
    user: CurrentUser,
    token: AuthToken,
) -> dict[str, Any]:
    return master_lock_service.acquire(user, token)


@app.delete("/api/master/lock")
def release_master_lock(
    _session_id: MasterSessionId,
    user: CurrentUser,
    token: AuthToken,
) -> dict[str, Any]:
    return master_lock_service.release(user, token)


@app.post("/api/master/lock/notify")
def notify_master_lock_owner(
    body: MasterLockNotificationRequest,
    _session_id: MasterSessionId,
    user: CurrentUser,
    token: AuthToken,
) -> dict[str, Any]:
    return master_lock_service.notify_owner(user, token, body.kind)


@app.get("/api/master/history")
def list_master_history(
    session_id: MasterSessionId,
    query: str = "",
    action: str | None = None,
    dateFrom: float | None = None,
    dateTo: float | None = None,
    offset: int = 0,
    limit: int = 200,
) -> dict[str, Any]:
    del session_id
    if offset < 0 or limit < 1 or limit > 500:
        raise AppError(
            "INVALID_PAGINATION",
            "Некорректные параметры страницы",
        )
    allowed_actions = {"added", "updated", "deleted", "restored"}
    if action is not None and action not in allowed_actions:
        raise AppError("INVALID_ACTION", "Неизвестный тип изменения")
    if (
        (dateFrom is not None and (not math.isfinite(dateFrom) or dateFrom < 0))
        or (dateTo is not None and (not math.isfinite(dateTo) or dateTo < 0))
        or (
            dateFrom is not None
            and dateTo is not None
            and dateFrom >= dateTo
        )
    ):
        raise AppError("INVALID_DATE_RANGE", "Некорректный диапазон дат")
    return master_service.history(
        query=query,
        action=action,
        offset=offset,
        limit=limit,
        date_from=dateFrom,
        date_to=dateTo,
    )


@app.delete("/api/master/history")
def clear_master_history(
    _user: Superuser,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.clear_history_and_reset_version(session_id)


@app.post("/api/master/imports/analyze")
def analyze_master_import(
    body: MasterImportAnalyzeRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.queue_import_analysis(body, session_id)


@app.get("/api/master/imports/active")
def active_master_import(
    session_id: MasterSessionId,
) -> dict[str, Any]:
    return master_service.get_active_import(session_id)


@app.get("/api/master/imports/{import_id}")
def get_master_import(
    import_id: str,
    session_id: MasterSessionId,
) -> dict[str, Any]:
    return master_service.get_import(import_id, session_id)


@app.get("/api/master/imports/{import_id}/items")
def list_master_import_items(
    import_id: str,
    session_id: MasterActionSessionId,
    status: str = "new",
    offset: int = 0,
    limit: int = 200,
) -> dict[str, Any]:
    if offset < 0 or limit < 1 or limit > 200:
        raise AppError(
            "INVALID_PAGINATION",
            "Некорректные параметры страницы",
        )
    return master_service.list_import_items(
        import_id,
        session_id,
        status=status,
        offset=offset,
        limit=limit,
    )


@app.get("/api/master/imports/{import_id}/duplicates")
def list_master_import_duplicates(
    import_id: str,
    session_id: MasterActionSessionId,
    offset: int = 0,
    limit: int = 200,
) -> dict[str, Any]:
    if offset < 0 or limit < 1 or limit > 200:
        raise AppError(
            "INVALID_PAGINATION",
            "Некорректные параметры страницы",
        )
    return master_service.list_import_duplicates(
        import_id,
        session_id,
        offset=offset,
        limit=limit,
    )


@app.put("/api/master/imports/{import_id}/items/{item_id}")
def update_master_import_item(
    import_id: str,
    item_id: str,
    body: MasterRecordRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.update_import_item(
        import_id,
        item_id,
        body,
        session_id,
    )


@app.post("/api/master/imports/{import_id}/merge")
def merge_master_import(
    import_id: str,
    body: MasterMergeRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.merge_import(import_id, body, session_id)


@app.post("/api/master/records", status_code=201)
def create_master_record(
    body: MasterRecordRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.create_record(body, session_id)


@app.post("/api/master/records/batch-delete-a")
def batch_delete_master_records(
    body: MasterBatchDeleteARequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.delete_records_by_a(body.aNumbers, session_id)


@app.post("/api/master/records/batch-delete-b")
def batch_delete_master_aons(
    body: MasterBatchDeleteBRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.delete_b_numbers(body.bNumbers, session_id)


@app.post("/api/master/records/batch-delete-b-scoped")
def batch_delete_master_aons_for_selected_records(
    body: MasterScopedBatchDeleteBRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.delete_b_numbers_for_a(
        body.aNumbers,
        body.bNumbers,
        session_id,
    )


@app.put("/api/master/records/{record_id}")
def update_master_record(
    record_id: str,
    body: MasterRecordRequest,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.update_record(record_id, body, session_id)


@app.delete("/api/master/records/{record_id}")
def delete_master_record(
    record_id: str,
    session_id: MasterActionSessionId,
    expectedVersion: int | None = None,
) -> dict[str, Any]:
    return master_service.delete_record(record_id, expectedVersion, session_id)


@app.delete("/api/master/records")
def clear_master_records(
    _user: Superuser,
    session_id: MasterActionSessionId,
) -> dict[str, Any]:
    return master_service.clear_records(session_id)


@app.get("/api/master/export")
def export_master(session_id: MasterActionSessionId) -> FileResponse:
    del session_id
    export_dir = settings.data_dir / "exports"
    export_path = export_dir / f"master-{opaque_id()}.csv"
    master_service.export_csv(export_path)
    return FileResponse(
        export_path,
        media_type="text/csv; charset=utf-8",
        filename="master.csv",
        background=BackgroundTask(export_path.unlink, missing_ok=True),
    )


@app.post("/api/uploads", status_code=201)
async def create_upload(
    session_id: SessionId,
    file: Annotated[UploadFile, File(...)],
) -> dict[str, Any]:
    record = await upload_service.save(file, session_id)
    return {
        "id": record.id,
        "name": record.name,
        "size": record.size,
        "format": record.format,
    }


@app.post("/api/uploads/{upload_id}/inspect")
def inspect_upload(
    upload_id: str,
    body: InspectRequest,
    session_id: SessionId,
) -> dict[str, Any]:
    record = registry.get_upload(upload_id, session_id)
    importer = importer_for(record.path, record.format)
    return validation_service.inspect_response(
        importer,
        requested_sheet=body.sheet,
        requested_mode=body.mode,
        preview_rows=body.previewRows,
    )


@app.post("/api/uploads/{upload_id}/mappings")
def list_upload_mappings(
    upload_id: str,
    body: MappingOptionsRequest,
    session_id: SessionId,
) -> dict[str, Any]:
    record = registry.get_upload(upload_id, session_id)
    importer = importer_for(record.path, record.format)
    return mapping_index_service.query(
        importer,
        record.path.parent / "mapping-index.sqlite3",
        requested_sheet=body.sheet,
        requested_mode=body.mode,
        a_column=body.aColumn,
        b_column=body.bColumn,
        query=body.query,
        offset=body.offset,
        limit=body.limit,
    )


@app.post("/api/jobs/convert", status_code=202)
def create_convert_job(
    body: ConvertRequest, session_id: SessionId
) -> dict[str, str]:
    job = job_service.create_convert(body, session_id)
    return {"jobId": job.id, "status": job.status}


@app.post("/api/jobs/delete-a", status_code=202)
def create_delete_a_job(
    body: DeleteARequest, session_id: SessionId
) -> dict[str, str]:
    job = job_service.create_delete_a(body, session_id)
    return {"jobId": job.id, "status": job.status}


@app.post("/api/jobs/delete-b", status_code=202)
def create_delete_b_job(
    body: DeleteBRequest, session_id: SessionId
) -> dict[str, str]:
    job = job_service.create_delete_b(body, session_id)
    return {"jobId": job.id, "status": job.status}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, session_id: SessionId) -> dict[str, Any]:
    return job_payload(registry.get_job(job_id, session_id))


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, session_id: SessionId) -> dict[str, Any]:
    return job_payload(job_service.cancel(job_id, session_id))


def _terminal_job(job_id: str, session_id: str) -> JobRecord:
    job = registry.get_job(job_id, session_id)
    if job.status not in TERMINAL_STATUSES:
        raise AppError(
            "JOB_NOT_FINISHED",
            "Задание еще не завершено",
            status_code=409,
        )
    return job


@app.get("/api/jobs/{job_id}/report")
def download_report(job_id: str, session_id: SessionId) -> FileResponse:
    job = _terminal_job(job_id, session_id)
    if not job.report_path.is_file():
        raise AppError("REPORT_NOT_FOUND", "Отчет не найден", status_code=404)
    return FileResponse(
        job.report_path,
        media_type="text/csv; charset=utf-8",
        filename="report.csv",
    )


@app.get("/api/jobs/{job_id}/download")
def download_result(job_id: str, session_id: SessionId) -> FileResponse:
    job = registry.get_job(job_id, session_id)
    if job.status != "completed" or not job.result_path.is_file():
        raise AppError(
            "RESULT_NOT_READY",
            "Результат задания еще не готов",
            status_code=409,
        )
    return FileResponse(
        job.result_path,
        media_type="text/csv",
        filename=f"result-{job.id[:8]}.csv",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/jobs/{job_id}/send-to-master")
def send_result_to_master(
    job_id: str,
    session_id: MasterSessionId,
    user: CurrentUser,
    token: AuthToken,
) -> dict[str, Any]:
    lock_state = master_lock_service.status(user, token)
    if lock_state["locked"] and not lock_state["ownedByCurrentUser"]:
        master_lock_service.notify_owner(user, token, "upload_attempt")
        owner_email = lock_state["owner"]["email"]
        raise AppError(
            "MASTER_LOCKED",
            (
                f"Мастер-файл сейчас занят пользователем {owner_email}. "
                "Пользователь получил уведомление о попытке загрузки."
            ),
            status_code=423,
        )
    job = registry.get_job(job_id, session_id)
    if job.status != "completed" or not job.result_path.is_file():
        raise AppError(
            "RESULT_NOT_READY",
            "Сначала дождитесь формирования файла",
            status_code=409,
        )
    upload_id = opaque_id()
    workspace = settings.data_dir / "uploads" / upload_id
    workspace.mkdir(parents=True, exist_ok=False)
    source = workspace / "source"
    shutil.copyfile(job.result_path, source)
    now = time.time()
    name = f"result-{job.id}.csv"
    registry.add_upload(
        UploadRecord(
            id=upload_id,
            session_id=session_id,
            name=name,
            size=source.stat().st_size,
            format="csv",
            path=source,
            created_at=now,
            expires_at=now + settings.object_ttl_seconds,
        )
    )
    return {"uploadId": upload_id, "name": name}


@app.get("/api/jobs/{job_id}/preview")
def preview_result(
    job_id: str,
    session_id: SessionId,
    limit: int | None = None,
) -> dict[str, Any]:
    if limit is not None and limit < 1:
        raise AppError("INVALID_PREVIEW_LIMIT", "limit должен быть больше нуля")
    return job_service.preview(registry.get_job(job_id, session_id), limit)
