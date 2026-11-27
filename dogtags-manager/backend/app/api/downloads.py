"""Admission precedes streaming; completion means accepted ASGI bytes, never disk saved."""
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse

from app.api.artifacts import integrity_error
from app.api.schemas import DownloadEvidenceState
from app.auth.policy import owned_case, permission, scoped_object
from app.db import get_db
from app.domain.approval import current_complete_set, find_approval_for_set
from app.errors import ApiError
from app.models import Artifact, ArtifactSet, AuditEvent, ProcessingRevision
from app.storage.local import CHUNK_BYTES

router = APIRouter(prefix="/api/cases/{case_id}/revisions/{revision_id}", tags=["downloads"])


@router.get("/artifacts/{artifact_id}/download-evidence", response_model=DownloadEvidenceState)
def read_download_evidence(case_id: UUID, revision_id: UUID, artifact_id: UUID,
                           user=Depends(permission("case.read")), db=Depends(get_db)):
    owned_case(db, user, case_id)
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case_id)
    artifact = scoped_object(db, user, Artifact, artifact_id, case_id=case_id)
    artifact_set = db.get(ArtifactSet, artifact.artifact_set_id)
    if artifact_set.revision_id != revision.id:
        raise ApiError(404, "not_found", "Артефакт не найден в доступном комплекте.")
    attempt = db.scalar(select(AuditEvent).where(AuditEvent.case_id == case_id,
                        AuditEvent.revision_id == revision.id, AuditEvent.action == "download.attempted",
                        AuditEvent.details["artifact_id"].astext == str(artifact.id)).order_by(
                        AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(1))
    latest = None
    if attempt:
        completion = db.scalar(select(AuditEvent).where(AuditEvent.case_id == case_id,
                               AuditEvent.revision_id == revision.id,
                               AuditEvent.action == "download.response_completed",
                               AuditEvent.details["attempt_id"].astext == attempt.details["attempt_id"]).limit(1))
        latest = {key: attempt.details[key] for key in ("attempt_id", "approval_id", "artifact_set_id",
                                                       "manifest_hash", "sha256", "size_bytes")}
        latest.update(attempted_at=attempt.created_at,
                      response_completed_at=completion.created_at if completion else None,
                      bytes_sent=completion.details["bytes_sent"] if completion else None)
    return {"revision_id": revision.id, "artifact_id": artifact.id, "latest_attempt": latest}


class ObservedDownload(StreamingResponse):
    def __init__(self, stream, artifact, sessions, audit_details, actor_id, case_id, revision_id):
        self.stream, self.sessions = stream, sessions
        self.audit_details, self.actor_id = audit_details, actor_id
        self.case_id, self.revision_id = case_id, revision_id
        self.expected_size = artifact.size_bytes
        super().__init__(self.chunks(), media_type="application/zip" if artifact.role == "ZIP"
                         else "text/csv; charset=utf-8" if artifact.role in ('ERRORS', 'ERROR_OTHER_OPERATOR')
                         else "text/csv; charset=windows-1251",
                         headers={"Content-Length": str(artifact.size_bytes),
                                  "Content-Disposition": f'attachment; filename="{artifact.download_filename}"',
                                  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    def chunks(self):
        while chunk := self.stream.read(CHUNK_BYTES):
            yield chunk

    def record_completion(self, size):
        with self.sessions() as db, db.begin():
            db.add(AuditEvent(case_id=self.case_id, revision_id=self.revision_id, actor_id=self.actor_id,
                              action="download.response_completed", details={**self.audit_details,
                              "bytes_sent": size, "evidence": "asgi_final_body_accepted"}))

    async def __call__(self, scope, receive, send):
        accepted, final_accepted = 0, False

        async def observed_send(message):
            nonlocal accepted, final_accepted
            await send(message)
            if message["type"] == "http.response.body":
                accepted += len(message.get("body", b""))
                if not message.get("more_body", False):
                    final_accepted = True

        try:
            await super().__call__(scope, receive, observed_send)
        finally:
            self.stream.close()
            if final_accepted and accepted == self.expected_size:
                await run_in_threadpool(self.record_completion, accepted)


@router.get("/artifacts/{artifact_id}/download")
def download_artifact(case_id: UUID, revision_id: UUID, artifact_id: UUID, request: Request,
                      expected_revision_id: UUID,
                      manifest_hash: str = Query(pattern=r"^[0-9a-f]{64}$"),
                      user=Depends(permission("package.approve")), db=Depends(get_db)):
    from app.domain.registry import read_snapshot
    read_snapshot(db, user.id)
    case = owned_case(db, user, case_id, lock=True)
    artifact = scoped_object(db, user, Artifact, artifact_id, case_id=case.id)
    if expected_revision_id != revision_id:
        raise ApiError(409, "revision_conflict", "Запрошенная ревизия не совпадает с ожидаемой.")
    revision, run, artifact_set, _ = current_complete_set(
        db, user, case, revision_id, manifest_hash, request.app.state.storage)
    if artifact.artifact_set_id != artifact_set.id:
        raise ApiError(404, "not_found", "Артефакт не найден в доступном комплекте.")
    decision = find_approval_for_set(db, artifact_set)
    if not decision or run.state != "APPROVED":
        raise ApiError(409, "package_not_approved", "Подтвердите актуальный полный комплект перед скачиванием.")
    try:
        stream = request.app.state.storage.path_for_key(artifact.storage_key).open("rb")
    except OSError:
        raise integrity_error() from None
    details = {"attempt_id": str(uuid4()), "approval_id": str(decision.id), "artifact_set_id": str(artifact_set.id),
               "manifest_hash": artifact_set.manifest_hash, "artifact_id": str(artifact.id), "role": artifact.role,
               "sha256": artifact.sha256, "size_bytes": artifact.size_bytes}
    try:
        response = ObservedDownload(stream, artifact, request.app.state.sessions, details, user.id, case.id, revision.id)
        db.add(AuditEvent(case_id=case.id, revision_id=revision.id, actor_id=user.id,
                          action="download.attempted", details=details))
        db.commit()  # Admission is fixed now; a later saved head cannot retract these immutable bytes.
    except BaseException:
        stream.close()
        raise
    return response
