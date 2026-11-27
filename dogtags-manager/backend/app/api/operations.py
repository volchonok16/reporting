from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.api.schemas import OperationState
from app.auth.policy import owned_case, permission, scoped_object
from app.db import get_db
from app.domain.operations import operation_view
from app.models import Operation
from app.errors import ApiError

router = APIRouter(prefix="/api/operations", tags=["operations"])


@router.get("", response_model=OperationState)
def recover_operation(operation_id: UUID, action: str = Query(min_length=1, max_length=80),
                      case_id: UUID | None = None, user=Depends(permission("case.read")), db=Depends(get_db)):
    if case_id:
        owned_case(db, user, case_id, allow_deleted=action == 'intake.archive')
    operation = db.scalar(select(Operation).where(
        Operation.owner_id == user.id, Operation.case_id == case_id, Operation.action == action,
        Operation.client_operation_id == operation_id))
    if not operation:
        raise ApiError(404, "not_found", "Операция не найдена в доступной области.")
    return operation_view(operation)


@router.get("/{operation_id}", response_model=OperationState)
def read_operation(operation_id: UUID, user=Depends(permission("case.read")), db=Depends(get_db)):
    return operation_view(scoped_object(db, user, Operation, operation_id))
