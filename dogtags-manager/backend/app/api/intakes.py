"""One uploaded file owns one persisted workflow; browser callbacks never enqueue work."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import select, tuple_
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from app.admin.publish_rules import active_snapshot
from app.api.schemas import (IntakeArchiveBody, IntakeDatabaseStatusBody, IntakeDecisionBody, IntakeDetail, IntakeOperationState,
                             IntakePage, IntakeRawPage, page_limit)
from app.api.sources import sanitized_filename
from app.auth.policy import check_mutation, owned_case, permission, scoped_object
from app.db import get_db
from app.domain.intakes import detail, details, next_decision_version, pending_upload, resume_upload
from app.domain.rules import PARTNERS
from app.domain.operations import canonical_digest, complete_operation, find_operation, replay_operation
from app.errors import ApiError
from app.models import Artifact, ArtifactDatabaseStatus, ArtifactSet, AuditEvent, Case, Intake, Operation, ProcessingRun, User, utcnow

router = APIRouter(prefix='/api/intakes', tags=['intakes'])


def reserve_upload(db, owner_id, operation_id, digest, staged, storage, filename, choices):
    # Run the entire locked transaction on a worker thread. A synchronous lock
    # wait on the ASGI loop would prevent the first upload's fsync from resuming.
    db.scalar(select(User).where(User.id == owner_id).with_for_update())
    receipt = find_operation(db, owner_id, None, 'intake.upload', operation_id, digest)
    retained = receipt is None
    if retained:
        pending = pending_upload(staged, storage, filename, choices, active_snapshot(db))
        receipt = Operation(owner_id=owner_id, action='intake.upload', client_operation_id=operation_id,
                            request_digest=digest, private_pending=pending)
        db.add(receipt)
    db.commit()
    return receipt.id, retained


@router.post('', response_model=IntakeOperationState, dependencies=[Depends(check_mutation)])
async def upload(request: Request, response: Response, operation_id: UUID = Header(alias='X-Operation-ID'),
                 partner: PARTNERS | None = Query(None),
                 operation: Literal['ADD', 'DELETE', 'CHANGE', 'STATUS', 'REPAIR', 'WHITEMAV'] | None = Query(None),
                 whitemav_inn: str | None = Query(None, min_length=10, max_length=12),
                 user=Depends(permission('case.edit')), db=Depends(get_db)):
    owner_id = user.id
    if operation == 'WHITEMAV':
        from app.domain.whitemav_inns import selected_inn
        selected_inn(db, owner_id, whitemav_inn)
    elif whitemav_inn is not None:
        raise ApiError(422, 'whitemav_only', 'Выбор ИНН доступен только для исключений из МАВ.')
    db.rollback()
    storage, settings = request.app.state.storage, request.app.state.settings
    staged, retained = None, False
    try:
        try:
            async with request.form(max_files=1, max_fields=0,
                                    max_part_size=settings.max_upload_bytes + settings.multipart_overhead_bytes) as form:
                file = form.get('file')
                if len(form.multi_items()) != 1 or not isinstance(file, UploadFile):
                    raise ApiError(422, 'file_required', 'Передайте один файл в поле file.')
                filename = sanitized_filename(file.filename)
                staged = await storage.stage_upload(file, settings.max_upload_bytes)
        except MultiPartException:
            raise ApiError(400, 'invalid_multipart', 'Передача файла повреждена.') from None
        choices = {key: value for key, value in {'partner': partner, 'operation': operation,
                                               'whitemav_inn': whitemav_inn}.items() if value}
        digest = canonical_digest({'sha256': staged.sha256, 'size_bytes': staged.size_bytes,
                                   'filename': filename, 'decisions': choices})
        receipt_id, retained = await run_in_threadpool(reserve_upload, db, owner_id, operation_id,
                                                       digest, staged, storage, filename, choices)
        await run_in_threadpool(resume_upload, request.app.state.sessions, receipt_id, storage)
        db.expire_all()
        receipt = db.get(Operation, receipt_id)
        response.status_code = 202 if receipt.status == 'RUNNING' else 200
        return replay_operation(receipt)
    finally:
        if staged and not retained:
            storage.discard(staged)


@router.get('', response_model=IntakePage)
def list_intakes(limit: int = Depends(page_limit), after: UUID | None = None, deleted: bool = False,
                 user=Depends(permission('case.read')), db=Depends(get_db)):
    if deleted:
        return {'items': [], 'next_cursor': None}
    query = select(Intake).join(Case).where(Case.owner_id == user.id).order_by(
        Intake.created_at.desc(), Intake.id.desc()).limit(limit + 1)
    query = query.where(Intake.deleted_at.is_not(None) if deleted else Intake.deleted_at.is_(None))
    if after:
        cursor = scoped_object(db, user, Intake, after)
        query = query.where(tuple_(Intake.created_at, Intake.id) < tuple_(cursor.created_at, cursor.id))
    rows = list(db.scalars(query))
    return {'items': details(db, rows[:limit]),
            'next_cursor': str(rows[limit - 1].id) if len(rows) > limit else None}


@router.get('/{intake_id}', response_model=IntakeDetail)
def read_intake(intake_id: UUID, user=Depends(permission('case.read')), db=Depends(get_db)):
    intake = scoped_object(db, user, Intake, intake_id)
    owned_case(db, user, intake.case_id)
    return detail(db, intake)


@router.post('/{intake_id}/archive', response_model=IntakeOperationState,
             dependencies=[Depends(check_mutation)])
def archive_state(intake_id: UUID, body: IntakeArchiveBody,
                  user=Depends(permission('case.edit')), db=Depends(get_db)):
    intake = scoped_object(db, user, Intake, intake_id, permission_name='case.edit')
    owned_case(db, user, intake.case_id, permission_name='case.edit', lock=True, allow_deleted=True)
    db.refresh(intake)
    digest = canonical_digest({'intake_id': str(intake_id), **body.model_dump(mode='json', exclude={'operation_id'})})
    receipt = find_operation(db, user.id, intake.case_id, 'intake.archive', body.operation_id, digest)
    if receipt:
        return replay_operation(receipt)
    if not body.deleted or intake.deleted_at:
        raise ApiError(409, 'intake_deleted', 'Удаление окончательное. Восстановление записи недоступно.')
    if intake.current_version_id != body.expected_version_id or intake.deleted_at != body.expected_deleted_at:
        raise ApiError(409, 'archive_state_conflict', 'Состояние файла изменилось. Обновите архив и повторите действие.')
    if body.deleted and db.scalar(select(ProcessingRun.id).where(ProcessingRun.case_id == intake.case_id,
            ProcessingRun.state.in_(('QUEUED', 'PROCESSING'))).limit(1)):
        raise ApiError(409, 'archive_processing_active', 'Дождитесь завершения обработки перед удалением файла.')
    intake.deleted_at = utcnow() if body.deleted else None
    receipt = Operation(owner_id=user.id, case_id=intake.case_id, action='intake.archive',
                        client_operation_id=body.operation_id, request_digest=digest)
    db.add(receipt)
    db.flush()
    result = detail(db, intake)
    complete_operation(receipt, result)
    db.add(AuditEvent(case_id=intake.case_id, actor_id=user.id, operation_id=receipt.id,
                     action='intake.deleted' if body.deleted else 'intake.restored',
                     details={'intake_id': str(intake.id), 'filename': result['source']['filename']}))
    db.commit()
    return replay_operation(receipt)


@router.post('/{intake_id}/database-status', response_model=IntakeOperationState,
             dependencies=[Depends(check_mutation)])
def database_status(intake_id: UUID, body: IntakeDatabaseStatusBody,
                    user=Depends(permission('case.edit')), db=Depends(get_db)):
    intake = scoped_object(db, user, Intake, intake_id, permission_name='case.edit')
    case = owned_case(db, user, intake.case_id, permission_name='case.edit', lock=True)
    db.refresh(intake)
    digest = canonical_digest({'intake_id': str(intake_id), **body.model_dump(mode='json', exclude={'operation_id'})})
    receipt = find_operation(db, user.id, intake.case_id, 'intake.database_status', body.operation_id, digest)
    if receipt:
        return replay_operation(receipt)
    target = intake
    if body.artifact_id:
        target = scoped_object(db, user, Artifact, body.artifact_id, case_id=intake.case_id,
                               permission_name='case.edit')
        artifact_set = db.get(ArtifactSet, target.artifact_set_id)
        if artifact_set.revision_id != case.head_revision_id:
            raise ApiError(409, 'revision_conflict', 'Комплект изменился. Обновите архив.')
        mark = db.get(ArtifactDatabaseStatus, target.id)
        if mark is None:
            mark = ArtifactDatabaseStatus(artifact_id=target.id, database_status='IN_PROGRESS')
            db.add(mark)
        target = mark
    if target.database_status != body.expected_status:
        raise ApiError(409, 'database_status_conflict', 'Статус уже изменился. Обновите архив.')
    target.database_status = body.status
    receipt = Operation(owner_id=user.id, case_id=intake.case_id, action='intake.database_status',
                        client_operation_id=body.operation_id, request_digest=digest)
    db.add(receipt)
    db.flush()
    complete_operation(receipt, detail(db, intake))
    db.add(AuditEvent(case_id=intake.case_id, actor_id=user.id, operation_id=receipt.id,
                     action='intake.database_status', details={'artifact_id': str(body.artifact_id) if body.artifact_id else None,
                                                               'before': body.expected_status, 'after': body.status}))
    db.commit()
    return replay_operation(receipt)


@router.post('/{intake_id}/decisions', response_model=IntakeOperationState, dependencies=[Depends(check_mutation)])
def save_decisions(intake_id: UUID, body: IntakeDecisionBody, request: Request,
                   user=Depends(permission('case.edit')), db=Depends(get_db)):
    intake = scoped_object(db, user, Intake, intake_id, permission_name='case.edit')
    owned_case(db, user, intake.case_id, permission_name='case.edit', lock=True)
    db.refresh(intake)
    digest = canonical_digest({'intake_id': str(intake_id), **body.model_dump(mode='json', exclude={'operation_id'})})
    receipt = find_operation(db, user.id, intake.case_id, 'intake.decisions', body.operation_id, digest)
    if receipt:
        return replay_operation(receipt)
    if intake.current_version_id != body.expected_version_id:
        raise ApiError(409, 'intake_version_conflict', 'Решения уже изменились. Откройте актуальное состояние файла.')
    choices = body.decisions.model_dump(mode='json', exclude_unset=True)
    if choices.get('delete_scope'):
        from app.domain.change import select_scope
        choices['delete_scope'] = select_scope(db, user, choices['delete_scope'], request.app.state.storage)
    from app.domain.returns import select_return
    select_return(db, user, intake, choices)
    next_decision_version(db, user, intake, choices)
    receipt = Operation(owner_id=user.id, case_id=intake.case_id, action='intake.decisions',
                        client_operation_id=body.operation_id, request_digest=digest)
    db.add(receipt)
    db.flush()
    complete_operation(receipt, detail(db, intake))
    db.add(AuditEvent(case_id=intake.case_id, actor_id=user.id, action='intake.decisions',
                     operation_id=receipt.id, details={'intake_id': str(intake.id),
                                                       'version_id': str(intake.current_version_id)}))
    db.commit()
    return replay_operation(receipt)


@router.get('/{intake_id}/records', response_model=IntakeRawPage)
def raw_records(intake_id: UUID, request: Request, assessment_id: UUID | None = None,
                after: int = Query(0, ge=0), limit: int = Depends(page_limit),
                user=Depends(permission('case.read')), db=Depends(get_db)):
    from app.domain.readers.base import raw_rows, read_raw_index
    from app.models import IntakeAssessment
    from app.storage.local import StorageFailure
    intake = scoped_object(db, user, Intake, intake_id)
    assessment_id = assessment_id or intake.current_assessment_id
    if assessment_id is None:
        raise ApiError(409, 'assessment_unavailable', 'Способ чтения ещё не определён.')
    assessment = scoped_object(db, user, IntakeAssessment, assessment_id, case_id=intake.case_id)
    if assessment.intake_id != intake.id or not assessment.result.get('raw_index_key'):
        raise ApiError(409, 'raw_table_unavailable', 'Выберите способ чтения и таблицу исходника.')
    key, source_id = assessment.result['raw_index_key'], assessment.source_asset_id
    db.rollback()
    try:
        index = read_raw_index(request.app.state.storage, key)
        if index['source_asset_id'] != str(source_id):
            raise StorageFailure()
        items = list(raw_rows(request.app.state.storage, index, after=after, limit=limit))
        last = items[-1]['ordinal'] if items else after
        page = {'items': items, 'next_cursor': last if last < index['summary']['parsed_records'] else None}
    except StorageFailure:
        raise ApiError(503, 'source_integrity_error', 'Сохранённая таблица недоступна или повреждена.', retryable=True) from None
    return {'intake_id': str(intake_id), 'assessment_id': str(assessment_id), 'source_asset_id': str(source_id),
            'columns': index['columns'], 'table_id': index['table_id'], **page}
