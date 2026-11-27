import secrets
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import select

from app.auth.accounts import token_digest, local_operator
from app.db import get_db
from app.errors import ApiError
from app.models import (Artifact, ArtifactSet, Case, Intake, IntakeAssessment, IntakeVersion, Operation,
                        ProcessingRevision, ProcessingRun, Session, SourceAsset, User, utcnow)


def active_session(request: Request, db=Depends(get_db)):
    token = request.cookies.get(request.app.state.settings.cookie_name)
    session = db.scalar(select(Session).where(Session.token_digest == token_digest(token))) if token else None
    if not session or session.revoked_at or session.expires_at <= utcnow():
        message = ('Обновите страницу для восстановления подключения.' if request.app.state.settings.local_access
                   else 'Сессия завершена. Войдите снова.')
        raise ApiError(401, "session_expired", message)
    return session


def current_user(request: Request, db=Depends(get_db)):
    if request.app.state.settings.local_access:
        return local_operator(db)
    session = active_session(request, db)
    user = db.get(User, session.user_id) if session.user_id else None
    if not user or not user.active:
        raise ApiError(401, "authentication_required", "Войдите в локальную учётную запись.")
    return user


def require_permission(user, permission):
    if permission not in user.permissions:
        raise ApiError(403, "permission_denied", "Для действия нет разрешения.")


def permission(name):
    def dependency(user=Depends(current_user)):
        require_permission(user, name)
        return user
    return dependency


def check_mutation(request: Request, session=Depends(active_session)):
    if request.headers.get("origin") not in request.app.state.settings.origins:
        raise ApiError(403, "origin_denied", "Источник запроса не разрешён.")
    supplied = request.headers.get("x-csrf-token", "")
    if not supplied or not secrets.compare_digest(supplied, session.csrf_token):
        raise ApiError(403, "csrf_denied", "Защитный токен запроса отсутствует или устарел.")
    return session


def owned_case(db, user, case_id: UUID, *, permission_name="case.read", lock=False, allow_deleted=False):
    require_permission(user, permission_name)
    statement = select(Case).where(Case.id == case_id, Case.owner_id == user.id)
    if lock:
        statement = statement.with_for_update(key_share=True)
    case = db.scalar(statement)
    if not case:
        raise ApiError(404, "not_found", "Объект не найден в доступной области.")
    if not allow_deleted and db.scalar(
        select(Intake.id).where(Intake.case_id == case.id, Intake.deleted_at.is_not(None))
    ):
        raise ApiError(409, 'intake_deleted', 'Запись удалена окончательно.')
    return case


def scoped_object(db, user, model, object_id: UUID, *, case_id: UUID | None = None,
                  permission_name="case.read"):
    """Every future ID endpoint uses this policy; nested IDs must belong to their Case."""
    require_permission(user, permission_name)
    if model is Artifact:
        statement = select(Artifact).join(ArtifactSet, Artifact.artifact_set_id == ArtifactSet.id).join(
            Case, ArtifactSet.case_id == Case.id).where(Artifact.id == object_id, Case.owner_id == user.id)
    elif model in {SourceAsset, ProcessingRevision, ProcessingRun, ArtifactSet, Intake, IntakeVersion, IntakeAssessment}:
        statement = select(model).join(Case, model.case_id == Case.id).where(
            model.id == object_id, Case.owner_id == user.id)
    elif model is Operation:
        statement = select(Operation).where(Operation.id == object_id, Operation.owner_id == user.id)
        if case_id:
            statement = statement.where(Operation.case_id == case_id)
    else:
        raise ValueError("An explicit scoped-object policy is required for this model.")
    if case_id and model is not Operation:
        statement = statement.where(Case.id == case_id)
    obj = db.scalar(statement)
    if not obj:
        raise ApiError(404, "not_found", "Объект не найден в доступной области.")
    return obj


def require_rule_publication(user):
    if not user or not user.active:
        raise ApiError(403, 'permission_denied', 'Публикация требует активной учётной записи администратора правил.')
    require_permission(user, 'rules.publish')
