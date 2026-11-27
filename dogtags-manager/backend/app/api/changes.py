"""Select explicit old-number evidence and create a linked DELETE → ADD revision."""
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select

from app.api.processing import enqueue, job_view
from app.api.schemas import ChangeBody, ChangeSourcePage, ChangeState, OperationState, SaveRevisionBody, page_limit
from app.api.views import revision_view
from app.auth.policy import check_mutation, owned_case, permission, scoped_object
from app.db import get_db
from app.domain.change import change_view, select_scope
from app.domain.operations import canonical_digest, complete_operation, find_operation, replay_operation
from app.domain.output_spec import output_spec, revision_spec
from app.domain.revisions import append_revision
from app.errors import ApiError
from app.models import Artifact, ArtifactSet, AuditEvent, Case, Operation, ProcessingRevision, SourceAsset

router = APIRouter(prefix='/api', tags=['changes'])


@router.get('/change-sources', response_model=ChangeSourcePage)
def list_change_sources(after: UUID | None = None, limit: int = Depends(page_limit),
                        user=Depends(permission('case.read')), db=Depends(get_db)):
    query = (select(Artifact, ArtifactSet).join(ArtifactSet, Artifact.artifact_set_id == ArtifactSet.id)
             .join(Case, ArtifactSet.case_id == Case.id).where(Case.owner_id == user.id,
                Artifact.role.in_(['DELETE', 'NUMBERS'])).order_by(Artifact.id).limit(limit + 1))
    if after:
        scoped_object(db, user, Artifact, after)
        query = query.where(Artifact.id > after)
    rows = list(db.execute(query))
    return {'items': [{'artifact_id': obj.id, 'case_id': bundle.case_id, 'revision_id': bundle.revision_id,
                      'artifact_set_id': bundle.id, 'manifest_hash': bundle.manifest_hash, 'role': obj.role,
                      'filename': obj.download_filename, 'sha256': obj.sha256,
                      'row_count': bundle.manifest['counts'][obj.role]} for obj, bundle in rows[:limit]],
            'next_cursor': str(rows[limit - 1][0].id) if len(rows) > limit else None}


@router.post('/cases/{case_id}/change', response_model=OperationState, dependencies=[Depends(check_mutation)])
def save_change(case_id: UUID, body: ChangeBody, request: Request,
                user=Depends(permission('case.edit')), db=Depends(get_db)):
    case = owned_case(db, user, case_id, permission_name='case.edit')
    digest = canonical_digest(body.model_dump(mode='json', exclude={'operation_id'}))
    operation = find_operation(db, user.id, case.id, 'change.save', body.operation_id, digest)
    if operation:
        return replay_operation(operation)
    selected = select_scope(db, user, body.delete_scope.model_dump(mode='json'), request.app.state.storage)
    db.rollback()  # Release the verification transaction before the head CAS lock.
    case = owned_case(db, user, case_id, permission_name='case.edit', lock=True)
    operation = find_operation(db, user.id, case.id, 'change.save', body.operation_id, digest)
    if operation:
        return replay_operation(operation)
    previous = scoped_object(db, user, ProcessingRevision, body.expected_revision_id, case_id=case_id,
                             permission_name='case.edit')
    if revision_spec(previous)['operation'] not in ('ADD', 'CHANGE'):
        raise ApiError(422, 'replacement_mapping_required', 'Для замены загрузите полный комплект полей ADD.')
    source = db.get(SourceAsset, previous.source_asset_id)
    draft = SaveRevisionBody(operation_id=body.operation_id, expected_revision_id=previous.id,
                             source_asset_id=source.id)
    revision = append_revision(db, user, case, previous, source, draft, {}, settings_updates={
        'operation': 'CHANGE', 'output_spec': output_spec('CHANGE'), 'delete_scope': selected})
    run = enqueue(db, revision)
    operation = Operation(owner_id=user.id, case_id=case.id, action='change.save',
                          client_operation_id=body.operation_id, request_digest=digest)
    db.add(operation)
    db.flush()
    complete_operation(operation, {'revision': revision_view(revision, source, run), 'job': job_view(run)})
    db.add(AuditEvent(case_id=case.id, revision_id=revision.id, actor_id=user.id, action='change.save',
        operation_id=operation.id, details={'parent_revision_id': str(previous.id),
                                          'delete_scope_artifact_id': selected['artifact_id']}))
    db.commit()
    return replay_operation(operation)


@router.get('/cases/{case_id}/revisions/{revision_id}/change', response_model=ChangeState)
def read_change(case_id: UUID, revision_id: UUID, user=Depends(permission('case.read')), db=Depends(get_db)):
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case_id)
    if revision.settings.get('operation') != 'CHANGE':
        raise ApiError(404, 'not_found', 'Ревизия не содержит связанного изменения.')
    return change_view(db, user, case_id, revision)
