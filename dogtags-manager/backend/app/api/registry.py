"""Indexed business registry with explicit resumable backfill and evidence reconciliation."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, true

from app.api.external_attempts import row_view, row_provenance
from app.api.schemas import (EvidencePage, EvidenceResolutionBody, EvidenceResolutionState,
                             RegistryBatchBody, RegistryBatchState, RegistryPage, RegistrySourcePage, page_limit)
from app.auth.policy import check_mutation, permission, scoped_object
from app.db import get_db
from app.domain.evidence import event_views, owned, resolve_evidence, row_states
from app.domain.registry import backfill_batch, incomplete, owner_lock, read_snapshot, rebuild_batch
from app.models import Artifact, EvidenceCoverage, EvidenceEvent, ExportRow, RegistryBackfill, RegistryEntry

router = APIRouter(prefix='/api/registry', tags=['registry'])


def entry_view(obj):
    return {key: getattr(obj, key) for key in ('id', 'kind', 'business_key', 'prepared_count', 'external_state')}


@router.get('', response_model=RegistryPage)
def read_registry(kind: Literal['CLIENT', 'LABEL', 'ASSIGNMENT'] | None = None,
                  state: Literal['UNKNOWN', 'APPLIED', 'DELETED', 'REJECTED', 'CONFLICT'] | None = None,
                  after: UUID | None = None, limit: int = Depends(page_limit),
                  user=Depends(permission('case.read')), db=Depends(get_db)):
    snapshot = read_snapshot(db, user.id)
    query = select(RegistryEntry).where(RegistryEntry.owner_id == user.id)
    if kind:
        query = query.where(RegistryEntry.kind == kind)
    if state:
        query = query.where(RegistryEntry.external_state == state)
    if after:
        owned(db, user.id, RegistryEntry, after)
        query = query.where(RegistryEntry.id > after)
    items = list(db.scalars(query.order_by(RegistryEntry.id).limit(limit + 1)))
    pending = incomplete(db, user.id)
    # One bounded lateral lookup per selected entry within one SQL statement;
    # original values are display provenance, never proof of external application.
    sample = (select(ExportRow.values).where(ExportRow.owner_id == user.id,
              ExportRow.kind == RegistryEntry.kind, ExportRow.business_key == RegistryEntry.business_key)
              .order_by(ExportRow.id).limit(1).correlate(RegistryEntry).lateral())
    displays = dict(db.execute(select(RegistryEntry.id, sample.c['values']).join(sample, true())
                    .where(RegistryEntry.id.in_([item.id for item in items[:limit]]))).all())
    return {'items': [{**entry_view(item), 'display_values': displays.get(item.id, {})}
                      for item in items[:limit]], 'snapshot_version': snapshot,
            'complete': pending == 0, 'incomplete_artifacts': pending,
            'next_cursor': items[limit - 1].id if len(items) > limit else None}


@router.post('/backfill', response_model=RegistryBatchState, dependencies=[Depends(check_mutation)])
def backfill(body: RegistryBatchBody, request: Request,
             user=Depends(permission('case.edit')), db=Depends(get_db)):
    clock = owner_lock(db, user.id)
    if body.artifact_id:
        scoped_object(db, user, Artifact, body.artifact_id)
    job = backfill_batch(db, user.id, request.app.state.storage, body.batch_size, body.artifact_id)
    if job:
        clock.version += 1
    elif body.artifact_id:
        # Completed files are skipped by the worker query. Return their durable
        # cursor so reopening one does not poll forever while other files remain.
        job = db.get(RegistryBackfill, body.artifact_id)
    result = {'artifact_id': job.artifact_id if job else None, 'cursor': job.cursor if job else None,
              'expected_rows': job.expected_rows if job else None,
              'artifact_complete': job.complete if job else None,
              'complete': incomplete(db, user.id) == 0, 'snapshot_version': clock.version}
    db.commit()
    return result


@router.post('/rebuild', response_model=RegistryBatchState, dependencies=[Depends(check_mutation)])
def rebuild(body: RegistryBatchBody, user=Depends(permission('case.edit')), db=Depends(get_db)):
    clock = owner_lock(db, user.id)
    cursor = rebuild_batch(db, user.id, body.after, body.batch_size)
    result = {'complete': cursor is None, 'snapshot_version': clock.version, 'next_cursor': cursor}
    db.commit()
    return result


@router.post('/resolutions', response_model=EvidenceResolutionState, dependencies=[Depends(check_mutation)])
def resolve(body: EvidenceResolutionBody, user=Depends(permission('case.edit')), db=Depends(get_db)):
    clock = owner_lock(db, user.id)
    obj = resolve_evidence(db, user, body, clock)
    result = {**{key: getattr(obj, key) for key in ('id', 'entry_id', 'chosen_event_id', 'reason', 'snapshot_version')},
              'author_id': obj.owner_id}
    db.commit()
    return result


@router.get('/{entry_id}/sources', response_model=RegistrySourcePage)
def registry_sources(entry_id: UUID, after: UUID | None = None, limit: int = Depends(page_limit),
                     user=Depends(permission('case.read')), db=Depends(get_db)):
    read_snapshot(db, user.id)
    entry = owned(db, user.id, RegistryEntry, entry_id)
    query = select(ExportRow).where(ExportRow.owner_id == user.id, ExportRow.kind == entry.kind,
                                    ExportRow.business_key == entry.business_key)
    if after:
        cursor = owned(db, user.id, ExportRow, after)
        if (cursor.kind, cursor.business_key) != (entry.kind, entry.business_key):
            from app.errors import ApiError
            raise ApiError(404, 'not_found', 'Курсор не принадлежит записи.')
        query = query.where(ExportRow.id > after)
    items = list(db.scalars(query.order_by(ExportRow.id).limit(limit + 1)))
    states = row_states(db, user.id, [item.id for item in items[:limit]])
    provenance = row_provenance(db, items[:limit])
    return {'items': [row_view(item, states, provenance) for item in items[:limit]],
            'next_cursor': items[limit - 1].id if len(items) > limit else None}


@router.get('/{entry_id}/evidence', response_model=EvidencePage)
def registry_evidence(entry_id: UUID, after: UUID | None = None, limit: int = Depends(page_limit),
                      user=Depends(permission('case.read')), db=Depends(get_db)):
    read_snapshot(db, user.id)
    entry = owned(db, user.id, RegistryEntry, entry_id)
    query = (select(EvidenceEvent).join(EvidenceCoverage, EvidenceCoverage.event_id == EvidenceEvent.id)
        .join(ExportRow, ExportRow.id == EvidenceCoverage.export_row_id).where(
            ExportRow.owner_id == user.id, ExportRow.kind == entry.kind, ExportRow.business_key == entry.business_key)
        .distinct())
    if after:
        owned(db, user.id, EvidenceEvent, after)
        query = query.where(EvidenceEvent.id > after)
    items = list(db.scalars(query.order_by(EvidenceEvent.id).limit(limit + 1)))
    return {'items': event_views(db, items[:limit]),
            'next_cursor': items[limit - 1].id if len(items) > limit else None}
