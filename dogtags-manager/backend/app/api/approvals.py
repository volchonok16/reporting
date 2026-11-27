from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select

from app.api.schemas import ApproveBody, OperationState, RevisionApprovalState
from app.auth.policy import check_mutation, owned_case, permission, scoped_object
from app.db import get_db
from app.domain.approval import approval_view, approve, find_approval_for_set
from app.domain.operations import replay_operation
from app.models import ArtifactSet, ProcessingRevision, ProcessingRun

router = APIRouter(prefix="/api/cases/{case_id}", tags=["approvals"])


@router.post("/approval", response_model=OperationState, dependencies=[Depends(check_mutation)])
def approve_package(case_id: UUID, body: ApproveBody, request: Request,
                    user=Depends(permission("package.approve")), db=Depends(get_db)):
    from app.domain.registry import read_snapshot
    read_snapshot(db, user.id)
    case = owned_case(db, user, case_id, lock=True)
    operation = approve(db, user, case, body, request.app.state.storage)
    db.commit()
    return replay_operation(operation)


@router.get("/revisions/{revision_id}/approval", response_model=RevisionApprovalState)
def read_approval(case_id: UUID, revision_id: UUID, user=Depends(permission("case.read")), db=Depends(get_db)):
    from app.domain.registry import read_snapshot
    read_snapshot(db, user.id)
    case = owned_case(db, user, case_id)
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case.id)
    artifact_set = db.scalar(select(ArtifactSet).where(ArtifactSet.revision_id == revision.id))
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id))
    decision = find_approval_for_set(db, artifact_set)
    current = case.head_revision_id == revision.id
    from app.domain.retries import snapshot_current
    current = current and snapshot_current(db, user.id, revision)
    approved = bool(current and decision and run and run.state == "APPROVED"
                    and artifact_set.run_id == run.id and artifact_set.generation == run.generation)
    return {"revision_id": revision.id, "head_revision_id": case.head_revision_id, "current": current,
            "approved": approved, "approval": approval_view(decision) if decision else None}
