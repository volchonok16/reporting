import hashlib
import json

from sqlalchemy import select

from app.errors import ApiError
from app.models import Operation, utcnow


def canonical_digest(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False).encode("utf-8")).hexdigest()


def find_operation(db, owner_id, case_id, action, client_id, digest):
    operation = db.scalar(select(Operation).where(
        Operation.owner_id == owner_id, Operation.case_id == case_id, Operation.action == action,
        Operation.client_operation_id == client_id))
    if operation and operation.request_digest != digest:
        raise ApiError(409, "operation_body_conflict", "Этот ID операции уже использован с другим содержимым.")
    return operation


def operation_view(operation):
    return {"id": str(operation.id), "operation_id": str(operation.client_operation_id),
            "case_id": str(operation.case_id) if operation.case_id else None,
            "action": operation.action, "status": operation.status, "result": operation.result,
            "error": operation.error, "created_at": operation.created_at.isoformat(),
            "completed_at": operation.completed_at.isoformat() if operation.completed_at else None}


def complete_operation(operation, result):
    operation.status, operation.result, operation.completed_at = "SUCCEEDED", result, utcnow()


def fail_operation(operation, error):
    operation.status = "FAILED"
    operation.error = {"status": error.status, "code": error.code, "message": error.message,
                       "retryable": error.retryable}
    operation.completed_at = utcnow()


def replay_operation(operation):
    if operation.status == "FAILED":
        error = operation.error
        raise ApiError(error["status"], error["code"], error["message"], retryable=error["retryable"],
                       operation_id=str(operation.id))
    return operation_view(operation)
