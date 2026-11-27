"""Owner-scoped exact-artifact external attempts and immutable coverage events."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from app.api.schemas import (EvidenceBody, EvidencePage, EvidenceState, ExportRowPage, ExternalAttemptBody,
                             ExternalAttemptState, ExternalAttemptPage, page_limit)
from app.auth.policy import check_mutation, permission, scoped_object
from app.db import get_db
from app.domain.evidence import add_evidence, attempt_views, create_attempt, event_views, owned, row_states
from app.domain.registry import owner_lock, read_snapshot
from app.models import Artifact, ArtifactSet, EvidenceEvent, ExportRow, ExternalAttempt, RegistryBackfill, ProcessingRevision

router = APIRouter(prefix='/api', tags=['external-evidence'])


@router.post('/external-attempts', response_model=ExternalAttemptState, dependencies=[Depends(check_mutation)])
def submit_attempt(body: ExternalAttemptBody, request: Request,
                   user=Depends(permission('case.edit')), db=Depends(get_db)):
    owner_lock(db, user.id)
    obj = create_attempt(db, user, body, request.app.state.storage)
    result = attempt_views(db, [obj])[0]
    db.commit()
    return result


@router.get('/external-attempts', response_model=ExternalAttemptPage)
def attempt_candidates(after: UUID | None = None, limit: int = Depends(page_limit),
                       user=Depends(permission('case.read')), db=Depends(get_db)):
    query = select(ExternalAttempt).where(ExternalAttempt.owner_id == user.id)
    if after:
        owned(db, user.id, ExternalAttempt, after)
        query = query.where(ExternalAttempt.id > after)
    items = list(db.scalars(query.order_by(ExternalAttempt.id).limit(limit + 1)))
    return {'items': attempt_views(db, items[:limit]),
            'next_cursor': items[limit - 1].id if len(items) > limit else None}


@router.get('/external-attempts/{attempt_id}', response_model=ExternalAttemptState)
def read_attempt(attempt_id: UUID, user=Depends(permission('case.read')), db=Depends(get_db)):
    return attempt_views(db, [owned(db, user.id, ExternalAttempt, attempt_id)])[0]


@router.post('/external-attempts/{attempt_id}/evidence', response_model=EvidenceState,
             dependencies=[Depends(check_mutation)])
def submit_evidence(attempt_id: UUID, body: EvidenceBody,
                    user=Depends(permission('case.edit')), db=Depends(get_db)):
    clock = owner_lock(db, user.id)
    attempt = owned(db, user.id, ExternalAttempt, attempt_id)
    obj = add_evidence(db, user, attempt, body, clock)
    result = event_views(db, [obj])[0]
    db.commit()
    return result


@router.get('/external-attempts/{attempt_id}/evidence', response_model=EvidencePage)
def read_evidence(attempt_id: UUID, after: UUID | None = None, limit: int = Depends(page_limit),
                  user=Depends(permission('case.read')), db=Depends(get_db)):
    owned(db, user.id, ExternalAttempt, attempt_id)
    query = select(EvidenceEvent).where(EvidenceEvent.owner_id == user.id, EvidenceEvent.attempt_id == attempt_id)
    if after:
        cursor = owned(db, user.id, EvidenceEvent, after)
        if cursor.attempt_id != attempt_id:
            from app.errors import ApiError
            raise ApiError(404, 'not_found', 'Курсор не принадлежит попытке.')
        query = query.where(EvidenceEvent.id > after)
    items = list(db.scalars(query.order_by(EvidenceEvent.id).limit(limit + 1)))
    return {'items': event_views(db, items[:limit]),
            'next_cursor': items[limit - 1].id if len(items) > limit else None}


@router.get('/artifacts/{artifact_id}/export-rows', response_model=ExportRowPage)
def read_export_rows(artifact_id: UUID, after: int = Query(0, ge=0), limit: int = Depends(page_limit),
                     user=Depends(permission('case.read')), db=Depends(get_db)):
    snapshot = read_snapshot(db, user.id)
    obj = scoped_object(db, user, Artifact, artifact_id)
    bundle = db.get(ArtifactSet, obj.artifact_set_id)
    job = db.get(RegistryBackfill, artifact_id)
    items = list(db.scalars(select(ExportRow).where(ExportRow.owner_id == user.id,
        ExportRow.artifact_id == artifact_id, ExportRow.ordinal > after).order_by(ExportRow.ordinal).limit(limit + 1)))
    states = row_states(db, user.id, [item.id for item in items[:limit]])
    provenance = row_provenance(db, items[:limit])
    return {'items': [row_view(item, states, provenance) for item in items[:limit]],
        'snapshot_version': snapshot,
        'next_cursor': items[limit - 1].ordinal if len(items) > limit else None,
        'complete': bool(job and job.complete), 'indexed_rows': job.cursor if job else 0,
        'expected_rows': bundle.manifest['counts'].get(obj.role, 0)}


def row_view(obj, states, provenance):
    state = states.get(obj.id, 'UNKNOWN')
    coverage = 'MISSING' if obj.id not in states else (state if state in ('UNKNOWN', 'CONFLICT') else 'KNOWN')
    return {'evidence_state': state, 'coverage_state': coverage, **provenance[obj.artifact_set_id], **{key: getattr(obj, key) for key in ('id', 'artifact_id', 'artifact_set_id', 'case_id',
                                              'ordinal', 'kind', 'business_key', 'values')}}


@router.get('/artifacts/{artifact_id}/external-attempts', response_model=ExternalAttemptPage)
def list_attempts(artifact_id: UUID, after: UUID | None = None, limit: int = Depends(page_limit),
                  user=Depends(permission('case.read')), db=Depends(get_db)):
    scoped_object(db, user, Artifact, artifact_id)
    query = select(ExternalAttempt).where(ExternalAttempt.owner_id == user.id,
                                          ExternalAttempt.artifact_id == artifact_id)
    if after:
        cursor = owned(db, user.id, ExternalAttempt, after)
        if cursor.artifact_id != artifact_id:
            from app.errors import ApiError
            raise ApiError(404, 'not_found', 'Курсор не принадлежит артефакту.')
        query = query.where(ExternalAttempt.id > after)
    items = list(db.scalars(query.order_by(ExternalAttempt.id).limit(limit + 1)))
    return {'items': attempt_views(db, items[:limit]),
            'next_cursor': items[limit - 1].id if len(items) > limit else None}


def row_provenance(db, rows):
    ids = {row.artifact_set_id for row in rows}
    return {bundle_id: {'revision_id': revision_id, 'source_asset_id': source_id}
            for bundle_id, revision_id, source_id in db.execute(select(ArtifactSet.id,
                ArtifactSet.revision_id, ProcessingRevision.source_asset_id).join(ProcessingRevision,
                ProcessingRevision.id == ArtifactSet.revision_id).where(ArtifactSet.id.in_(ids)))}


@router.get('/external-evidence/{event_id}', response_model=EvidenceState)
def read_event(event_id: UUID, user=Depends(permission('case.read')), db=Depends(get_db)):
    return event_views(db, [owned(db, user.id, EvidenceEvent, event_id)])[0]
