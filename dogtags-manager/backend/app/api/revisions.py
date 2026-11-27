from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.api.schemas import OperationState, SaveRevisionBody
from app.auth.policy import check_mutation, permission
from app.db import get_db
from app.domain.operations import replay_operation
from app.domain.revisions import save_draft

router = APIRouter(prefix="/api/cases", tags=["revisions"])


@router.post("/{case_id}/revisions", response_model=OperationState, dependencies=[Depends(check_mutation)])
def save_revision(case_id: UUID, body: SaveRevisionBody, request: Request,
                  user=Depends(permission("case.edit")), db=Depends(get_db)):
    operation = save_draft(db, user, case_id, body, request.app.state.storage)
    db.commit()
    return replay_operation(operation)
