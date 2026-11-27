"""Short launch transactions; no CSV/global computation in HTTP."""
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select

from app.api.schemas import DiscoveryProcessingState, OperationState, ProcessingState, SaveRevisionBody, StartProcessingBody
from app.auth.policy import check_mutation, owned_case, permission, scoped_object
from app.db import get_db
from app.domain.operations import canonical_digest, complete_operation, find_operation, replay_operation
from app.domain.revisions import save_draft
from app.errors import ApiError
from app.models import AuditEvent, Operation, Outbox, ProcessingRevision, ProcessingRun, utcnow
from app.processing.leases import reset_outbox

router = APIRouter(prefix="/api/cases/{case_id}/processing", tags=["processing"])


def job_view(run):
    result = {"id": str(run.id), "case_id": str(run.case_id), "revision_id": str(run.revision_id) if run.revision_id else None,
            "state": run.state, "attempt": run.attempt, "generation": run.generation,
            "progress": run.progress, "summary": run.summary, "error": run.error,
            "next_attempt_at": run.next_attempt_at.isoformat() if run.next_attempt_at else None,
            "created_at": run.created_at.isoformat()}
    if run.kind == 'DISCOVER':
        result.update(kind='DISCOVER', intake_version_id=str(run.intake_version_id))
    return result


def enqueue(db, revision):
    run = ProcessingRun(case_id=revision.case_id, revision_id=revision.id,
                        work_identity=canonical_digest({"revision_id": str(revision.id),
                                                        "config_hash": revision.config_hash,
                                                        "rules": revision.rules_version,
                                                        "serializer": revision.serializer_version}),
                        state="QUEUED", progress={"stage": "queued", "percent": 0})
    db.add(run)
    db.flush()
    db.add(Outbox(run_id=run.id))
    db.flush()
    return run


def receipt(db, user, operation, run):
    result = dict(operation.result or {})
    result["job"] = job_view(run)
    if "revision" in result:
        result["revision"] = {**result["revision"], "state": run.state, "run_id": str(run.id)}
    complete_operation(operation, result)
    db.add(AuditEvent(case_id=run.case_id, revision_id=run.revision_id, actor_id=user.id,
                      action="processing.queued", operation_id=operation.id, details={"job_id": str(run.id)}))


@router.post("/save-and-start", response_model=OperationState, dependencies=[Depends(check_mutation)])
def save_and_start(case_id: UUID, body: SaveRevisionBody, request: Request,
                   user=Depends(permission("case.edit")), db=Depends(get_db)):
    operation = save_draft(db, user, case_id, body, request.app.state.storage, action="processing.save_start")
    if operation.result and "job" in operation.result:
        return replay_operation(operation)
    revision = db.get(ProcessingRevision, UUID(operation.result["revision"]["id"]))
    run = enqueue(db, revision)
    receipt(db, user, operation, run)
    db.commit()
    return replay_operation(operation)


def launch(db, user, case_id, body, *, retry=False):
    case = owned_case(db, user, case_id, permission_name="case.edit", lock=True)
    action = "processing.retry" if retry else "processing.start"
    digest = canonical_digest(body.model_dump(mode="json", exclude={"operation_id"}))
    previous = find_operation(db, user.id, case.id, action, body.operation_id, digest)
    if previous:
        return previous
    revision = scoped_object(db, user, ProcessingRevision, body.expected_revision_id, case_id=case_id,
                             permission_name="case.edit")
    if case.head_revision_id != revision.id:
        raise ApiError(409, "revision_conflict", "Текущая ревизия изменилась. Запустите сохранённую текущую версию.")
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id).with_for_update())
    if retry:
        if not run or run.state != "FAILED" or not run.error or not run.error["retryable"]:
            raise ApiError(409, "retry_unavailable", "Для этой ревизии нет повторяемой технической ошибки.")
        db.add(AuditEvent(case_id=case.id, revision_id=revision.id, actor_id=user.id,
                          action="processing.retry_requested", details={"job_id": str(run.id),
                          "previous_attempts": run.attempt, "previous_error": run.error}))
        run.state, run.attempt, run.error, run.next_attempt_at = "QUEUED", 0, None, None
        run.generation += 1
        run.progress = {"stage": "queued", "percent": 0}
        reset_outbox(db, run, utcnow())
    elif run:
        raise ApiError(409, "processing_already_started", "Эта ревизия уже запущена; прочитайте состояние задачи.")
    else:
        run = enqueue(db, revision)
    operation = Operation(owner_id=user.id, case_id=case.id, action=action,
                          client_operation_id=body.operation_id, request_digest=digest)
    db.add(operation)
    db.flush()
    receipt(db, user, operation, run)
    return operation


@router.post("/start", response_model=OperationState, dependencies=[Depends(check_mutation)])
def start(case_id: UUID, body: StartProcessingBody, user=Depends(permission("case.edit")), db=Depends(get_db)):
    operation = launch(db, user, case_id, body)
    db.commit()
    return replay_operation(operation)


@router.post("/retry", response_model=OperationState, dependencies=[Depends(check_mutation)])
def retry(case_id: UUID, body: StartProcessingBody, user=Depends(permission("case.edit")), db=Depends(get_db)):
    operation = launch(db, user, case_id, body, retry=True)
    db.commit()
    return replay_operation(operation)


@router.get("/{job_id}", response_model=ProcessingState | DiscoveryProcessingState)
def read_job(case_id: UUID, job_id: UUID, user=Depends(permission("case.read")), db=Depends(get_db)):
    owned_case(db, user, case_id)
    return job_view(scoped_object(db, user, ProcessingRun, job_id, case_id=case_id))
