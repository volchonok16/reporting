from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.schemas import CasePage, CaseState, OperationState, RevisionState, page_limit
from app.api.views import case_view, revision_view
from app.auth.policy import check_mutation, owned_case, permission, scoped_object
from app.db import get_db
from app.domain.operations import canonical_digest, complete_operation, find_operation, replay_operation
from app.models import AuditEvent, Case, Operation, ProcessingRevision, ProcessingRun, SourceAsset, User

router = APIRouter(prefix="/api/cases", tags=["cases"])


class CreateCaseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    title: str = Field(default="HUB", min_length=1, max_length=240)


@router.post("", response_model=OperationState, dependencies=[Depends(check_mutation)])
def create_case(body: CreateCaseBody, user=Depends(permission("case.edit")), db=Depends(get_db)):
    # A per-owner lock covers the NULL Case scope of case.create operations.
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    digest = canonical_digest({"title": body.title})
    previous = find_operation(db, user.id, None, "case.create", body.operation_id, digest)
    if previous:
        return replay_operation(previous)
    case = Case(owner_id=user.id, title=body.title)
    operation = Operation(owner_id=user.id, case_id=None, action="case.create",
                          client_operation_id=body.operation_id, request_digest=digest)
    db.add_all([case, operation])
    db.flush()
    complete_operation(operation, {"case": case_view(case)})
    db.add(AuditEvent(case_id=case.id, actor_id=user.id, action="case.create", operation_id=operation.id))
    db.commit()
    return replay_operation(operation)


@router.get("", response_model=CasePage)
def list_cases(limit: int = Depends(page_limit), after: UUID | None = None,
               user=Depends(permission("case.read")), db=Depends(get_db)):
    statement = select(Case).where(Case.owner_id == user.id).order_by(Case.id).limit(limit + 1)
    if after:
        owned_case(db, user, after)
        statement = statement.where(Case.id > after)
    cases = list(db.scalars(statement))
    return {"items": [case_view(case) for case in cases[:limit]],
            "next_cursor": str(cases[limit - 1].id) if len(cases) > limit else None}


@router.get("/{case_id}", response_model=CaseState)
def read_case(case_id: UUID, user=Depends(permission("case.read")), db=Depends(get_db)):
    case = owned_case(db, user, case_id)
    result = case_view(case)
    revision = scoped_object(db, user, ProcessingRevision, case.head_revision_id, case_id=case.id
                             ) if case.head_revision_id else None
    result["revision"] = revision_view(revision, scoped_object(db, user, SourceAsset, revision.source_asset_id,
                                                              case_id=case.id),
                                       db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id))
                                       ) if revision else None
    return result


@router.get("/{case_id}/revisions/{revision_id}", response_model=RevisionState)
def read_revision(case_id: UUID, revision_id: UUID, user=Depends(permission("case.read")), db=Depends(get_db)):
    owned_case(db, user, case_id)
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case_id)
    source = scoped_object(db, user, SourceAsset, revision.source_asset_id, case_id=case_id)
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id))
    return revision_view(revision, source, run)
