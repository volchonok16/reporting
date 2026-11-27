from pathlib import PurePath
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from app.api.schemas import IntakeSourceState, OperationState, SourceState
from app.api.views import revision_view, source_view
from app.auth.policy import check_mutation, owned_case, permission, scoped_object
from app.db import get_db
from app.domain.operations import (canonical_digest, complete_operation, fail_operation, find_operation,
                                   replay_operation)
from app.domain.manifest import capture_filename_components
from app.domain.source_inspection import HUB_CONTRACT, inspect_source
from app.errors import ApiError
from app.models import AuditEvent, Operation, ProcessingRevision, SourceAsset, SourceProfileVersion, utcnow
from app.storage import StorageFailure

router = APIRouter(tags=["sources"])


def sanitized_filename(filename):
    name = PurePath((filename or "source.csv").replace("\\", "/")).name
    return "".join(c for c in name if c >= " " and c != "\x7f")[:240] or "source.csv"


def expected_head(case, expected_revision_id):
    if case.head_revision_id != expected_revision_id:
        raise ApiError(409, "revision_conflict", "Текущая ревизия изменилась. Откройте сохранённую версию.")


def saved_upload(db, user, case, operation, staged, key, inspection, filename, encoding, settings):
    previous = db.get(ProcessingRevision, case.head_revision_id) if case.head_revision_id else None
    profile = db.scalar(select(SourceProfileVersion).where(SourceProfileVersion.version == HUB_CONTRACT["version"]))
    source = SourceAsset(id=uuid4(), case_id=case.id, created_by=user.id, filename=filename, encoding=encoding,
                         sha256=staged.sha256, size_bytes=staged.size_bytes, storage_key=key, inspection=inspection)
    db.add(source)
    db.flush()
    # Replacement carries accepted settings, but corrections address the old SourceAsset and cannot transfer.
    snapshot = previous.profile_snapshot if previous else profile.snapshot
    from copy import deepcopy
    from app.domain.output_spec import source_spec
    saved_settings = deepcopy(previous.settings) if previous else {}
    if not saved_settings.get('retry') and saved_settings.get('operation', 'ADD') in ('ADD', 'DELETE'):
        saved_settings['operation'] = saved_settings.get('operation', 'ADD')
        saved_settings.update(row_error_policy='separate-source-errors-v1', filename_policy='short-output-v1',
                              output_spec=source_spec(saved_settings['operation']))
    revision_id, sequence = uuid4(), previous.sequence + 1 if previous else 1
    revision = ProcessingRevision(
        id=revision_id, case_id=case.id, source_asset_id=source.id, parent_revision_id=case.head_revision_id,
        sequence=sequence, created_by=user.id, profile_version_id=(
            previous.profile_version_id if previous else profile.id), profile_snapshot=snapshot,
        settings=saved_settings, correction_overlay=[], config_hash=canonical_digest(
            {"profile": snapshot, "settings": saved_settings, "correction_overlay": []}),
        export_timestamp=utcnow(), export_timezone=settings.timezone,
        filename_components=capture_filename_components(case.id, revision_id, sequence, filename),
    )
    db.add(revision)
    db.flush()
    case.head_revision_id = revision.id
    result = {"source": source_view(source), "revision": revision_view(revision, source)}
    complete_operation(operation, result)
    db.add(AuditEvent(case_id=case.id, revision_id=revision.id, actor_id=user.id, action="source.upload",
                      operation_id=operation.id, details={"source_asset_id": str(source.id)}))
    db.commit()
    return replay_operation(operation)


@router.post("/api/cases/{case_id}/sources", response_model=OperationState,
             responses={202: {"model": OperationState}}, dependencies=[Depends(check_mutation)])
async def upload_source(case_id: UUID, request: Request, response: Response,
                        encoding: Literal["utf-8", "cp1251"] = Query(...),
                        expected_revision_id: UUID | None = Query(None),
                        operation_id: UUID = Header(alias="X-Operation-ID"),
                        user=Depends(permission("case.edit")), db=Depends(get_db)):
    owned_case(db, user, case_id, permission_name="case.edit")
    db.rollback()  # Do not retain a database transaction while receiving/inspecting the file.
    storage, settings = request.app.state.storage, request.app.state.settings
    staged = None
    try:
        try:
            async with request.form(max_files=1, max_fields=0,
                                    max_part_size=settings.max_upload_bytes + settings.multipart_overhead_bytes) as form:
                file = form.get("file")
                if len(form.multi_items()) != 1 or not isinstance(file, UploadFile):
                    raise ApiError(422, "file_required", "Передайте один файл в поле file.")
                filename = sanitized_filename(file.filename)
                staged = await storage.stage_upload(file, settings.max_upload_bytes)
        except MultiPartException:
            raise ApiError(400, "invalid_multipart", "Передача файла повреждена.") from None
        digest = canonical_digest({"sha256": staged.sha256, "size_bytes": staged.size_bytes,
                                   "filename": filename, "encoding": encoding,
                                   "expected_revision_id": str(expected_revision_id) if expected_revision_id else None})
        case = owned_case(db, user, case_id, permission_name="case.edit", lock=True)
        previous = find_operation(db, user.id, case.id, "source.upload", operation_id, digest)
        if previous:
            # Receipt replay survives later head changes; supplied bytes were independently hashed above.
            result = replay_operation(previous)
            response.status_code = 202 if previous.status == "RUNNING" else 200
            return result
        expected_head(case, expected_revision_id)
        operation = Operation(owner_id=user.id, case_id=case.id, action="source.upload",
                              client_operation_id=operation_id, request_digest=digest)
        db.add(operation)
        db.commit()  # Durable pending state, recoverable if raw publication or the response is interrupted.
        try:
            key = await run_in_threadpool(storage.publish, staged)
            inspection = await run_in_threadpool(inspect_source, staged.path, encoding, settings.max_upload_bytes)
        except (StorageFailure, OSError):
            error = ApiError(503, "storage_unavailable", "Исходный файл не сохранён. Повторите с новым ID операции.",
                             retryable=True, operation_id=str(operation.id))
            fail_operation(operation, error)
            db.commit()
            raise error from None
        # Publication runs outside the transaction; the retained ORM identity
        # must not hide a head committed by another upload before this lock.
        db.expire(case)
        case = owned_case(db, user, case_id, permission_name="case.edit", lock=True)
        try:
            expected_head(case, expected_revision_id)
        except ApiError as error:
            fail_operation(operation, error)
            db.commit()
            error.operation_id = str(operation.id)
            raise
        return saved_upload(db, user, case, operation, staged, key, inspection, filename, encoding, settings)
    finally:
        if staged:
            storage.discard(staged)


@router.get("/api/cases/{case_id}/sources/{source_id}", response_model=SourceState | IntakeSourceState)
def read_source(case_id: UUID, source_id: UUID, user=Depends(permission("case.read")), db=Depends(get_db)):
    owned_case(db, user, case_id)
    return source_view(scoped_object(db, user, SourceAsset, source_id, case_id=case_id))


@router.get("/api/cases/{case_id}/sources/{source_id}/raw")
def raw_source(case_id: UUID, source_id: UUID, request: Request,
               user=Depends(permission("case.read")), db=Depends(get_db)):
    owned_case(db, user, case_id)
    source = scoped_object(db, user, SourceAsset, source_id, case_id=case_id)
    try:
        path = request.app.state.storage.verify(source.storage_key, source.sha256, source.size_bytes)
    except StorageFailure:
        raise ApiError(503, "source_integrity_error", "Сохранённый источник недоступен или повреждён.",
                       retryable=True) from None
    return FileResponse(path, media_type="application/octet-stream", filename=source.filename,
                        headers={"Cache-Control": "no-store"})
