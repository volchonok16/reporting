"""External attempts and events are independent of file preparation, approval and download."""
from uuid import uuid4

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert

from app.auth.policy import scoped_object
from app.domain.operations import canonical_digest
from app.domain.registry import effective_event_ids, refresh, refresh_affected, stages_for_bundle
from app.errors import ApiError
from app.models import (Artifact, ArtifactSet, AttemptAncestor, EvidenceCoverage, EvidenceEvent,
                        EvidenceResolution, ExportRow, ExternalAttempt,
                        RegistryEntry, ResolutionEvidence, SourceAsset, StageArtifact, ProcessingRevision)
from app.storage.artifact_sets import verify_artifact_set
from app.storage.local import StorageFailure


def owned(db, owner_id, model, object_id):
    obj = db.scalar(select(model).where(model.id == object_id, model.owner_id == owner_id))
    if not obj:
        raise ApiError(404, 'not_found', 'Объект не найден в доступной области.')
    return obj


def replay(db, owner_id, model, body, *, context=None):
    digest = canonical_digest({'body': body.model_dump(mode='json', exclude={'operation_id'}), 'context': context})
    obj = db.scalar(select(model).where(model.owner_id == owner_id, model.operation_id == body.operation_id))
    if obj and obj.request_digest != digest:
        raise ApiError(409, 'operation_body_conflict', 'ID операции уже использован с другим содержимым.')
    return obj, digest


def attempt_views(db, objects):
    predecessors = {obj.id: [] for obj in objects}
    if predecessors:
        for attempt_id, ancestor_id in db.execute(select(AttemptAncestor.attempt_id, AttemptAncestor.ancestor_id)
                .where(AttemptAncestor.attempt_id.in_(predecessors), AttemptAncestor.direct)
                .order_by(AttemptAncestor.ancestor_id)):
            predecessors[attempt_id].append(ancestor_id)
    metadata = {artifact_id: {'filename': filename, 'role': role, 'case_id': case_id,
                 'revision_id': revision_id, 'revision_sequence': sequence}
                for artifact_id, filename, role, case_id, revision_id, sequence in db.execute(
                    select(Artifact.id, Artifact.download_filename, Artifact.role, ArtifactSet.case_id,
                           ArtifactSet.revision_id, ProcessingRevision.sequence)
                    .join(ArtifactSet, Artifact.artifact_set_id == ArtifactSet.id)
                    .join(ProcessingRevision, ArtifactSet.revision_id == ProcessingRevision.id)
                    .where(Artifact.id.in_({obj.artifact_id for obj in objects})))}
    return [{**metadata[obj.artifact_id], **{key: getattr(obj, key) for key in ('id', 'artifact_id', 'artifact_set_id', 'stage_id',
             'manifest_hash', 'owner_id', 'reason', 'created_at')},
             'predecessor_ids': predecessors[obj.id]} for obj in objects]


def create_attempt(db, user, body, storage):
    existing, digest = replay(db, user.id, ExternalAttempt, body)
    if existing:
        return existing
    artifact = scoped_object(db, user, Artifact, body.artifact_id)
    bundle = db.get(ArtifactSet, artifact.artifact_set_id)
    if artifact.role in ('ZIP', 'ERRORS', 'ERROR_OTHER_OPERATOR'):
        raise ApiError(422, 'attempt_requires_csv', 'Попытка относится к конкретному CSV.')
    if bundle.id != body.artifact_set_id or bundle.manifest_hash != body.manifest_hash:
        raise ApiError(409, 'artifact_identity_conflict', 'Комплект и manifest не соответствуют артефакту.')
    try:
        verify_artifact_set(db, bundle, storage)
        stages_for_bundle(db, bundle)
    except StorageFailure:
        raise ApiError(503, 'artifact_integrity_error', 'Артефакт повреждён или недоступен.') from None
    link = db.scalar(select(StageArtifact).where(StageArtifact.artifact_id == artifact.id))
    if body.stage_id and body.stage_id != link.stage_id:
        raise ApiError(409, 'stage_identity_conflict', 'Стадия не соответствует артефакту.')
    predecessors = set(body.predecessor_ids)
    # A correction retry is causally after the pinned attempt that produced its return.
    # Preserve that attempt's proven stage/dependency ancestry on each new external submission.
    from app.models import ProcessingRevision
    revision = db.get(ProcessingRevision, bundle.revision_id)
    if revision.settings.get('retry'):
        from uuid import UUID
        predecessors.add(UUID(revision.settings['retry']['attempt_id']))
    for predecessor in predecessors:
        owned(db, user.id, ExternalAttempt, predecessor)
    obj = ExternalAttempt(owner_id=user.id, case_id=bundle.case_id, artifact_set_id=bundle.id,
        artifact_id=artifact.id, stage_id=link.stage_id, manifest_hash=bundle.manifest_hash,
        reason=body.reason, operation_id=body.operation_id, request_digest=digest)
    db.add(obj)
    db.flush()
    if predecessors:
        db.execute(text("""INSERT INTO attempt_ancestors (owner_id,attempt_id,ancestor_id,direct)
            SELECT :owner_id,:attempt_id,ancestor_id,bool_or(direct) FROM (
              SELECT unnest(CAST(:predecessors AS uuid[])) AS ancestor_id,true AS direct
              UNION ALL SELECT ancestor_id,false FROM attempt_ancestors
                WHERE owner_id=:owner_id AND attempt_id=ANY(:predecessors)
            ) inherited GROUP BY ancestor_id"""),
            {'owner_id': user.id, 'attempt_id': obj.id, 'predecessors': list(predecessors)})
    return obj


def event_views(db, objects):
    counts = dict(db.execute(select(EvidenceCoverage.event_id, func.count())
        .where(EvidenceCoverage.event_id.in_([obj.id for obj in objects]))
        .group_by(EvidenceCoverage.event_id)).all()) if objects else {}
    return [{**{key: getattr(obj, key) for key in ('id', 'attempt_id', 'artifact_id', 'author_id', 'reason',
        'origin', 'source_asset_id', 'return_assessment_id', 'outcome', 'coverage', 'snapshot_version', 'created_at')},
        'covered_rows': counts.get(obj.id, 0)} for obj in objects]


def check_snapshot(clock, expected):
    if expected is not None and expected != clock.version:
        raise ApiError(409, 'evidence_snapshot_changed', 'Внешние свидетельства изменились; перечитайте состояние.')


def add_evidence(db, user, attempt, body, clock):
    existing, digest = replay(db, user.id, EvidenceEvent, body, context=str(attempt.id))
    if existing:
        return existing
    check_snapshot(clock, body.expected_snapshot_version)
    if (not body.reason.strip() or (body.coverage == 'ROWS') != bool(body.export_row_ids)
            or body.outcome == 'PARTIAL' and body.coverage != 'UNKNOWN'
            or body.coverage == 'UNKNOWN' and body.outcome not in ('PARTIAL', 'UNKNOWN')
            or (body.origin == 'RETURN') != bool(body.source_asset_id)):
        raise ApiError(422, 'evidence_coverage_invalid', 'Укажите точное покрытие и происхождение свидетельства.')
    source = scoped_object(db, user, SourceAsset, body.source_asset_id) if body.source_asset_id else None
    rows = set(body.export_row_ids)
    if rows:
        count = db.scalar(select(func.count()).select_from(ExportRow).where(
            ExportRow.id.in_(rows), ExportRow.owner_id == user.id, ExportRow.artifact_id == attempt.artifact_id))
        if count != len(rows):
            raise ApiError(404, 'export_row_not_found', 'Строка не принадлежит артефакту этой попытки.')
    clock.version += 1
    event = EvidenceEvent(id=uuid4(), owner_id=user.id, artifact_id=attempt.artifact_id, attempt_id=attempt.id,
        author_id=user.id, reason=body.reason, origin=body.origin, source_asset_id=body.source_asset_id,
        source_case_id=source.case_id if source else None, outcome=body.outcome, coverage=body.coverage,
        operation_id=body.operation_id, request_digest=digest, snapshot_version=clock.version)
    db.add(event)
    db.flush()
    if body.coverage != 'UNKNOWN':
        query = select(ExportRow.owner_id, ExportRow.artifact_id, text(':event_id'), ExportRow.id).where(
            ExportRow.artifact_id == attempt.artifact_id, ExportRow.owner_id == user.id)
        if rows:
            query = query.where(ExportRow.id.in_(rows))
        db.execute(insert(EvidenceCoverage.__table__).from_select(
            ['owner_id', 'artifact_id', 'event_id', 'export_row_id'], query), {'event_id': event.id})
    refresh_affected(db, user.id, attempt.artifact_id)
    return event


def cover_backfilled_rows(db, owner_id, artifact_id, start):
    """A full-file statement still covers exact immutable rows discovered after it arrived."""
    db.execute(text('''INSERT INTO evidence_coverage (owner_id,artifact_id,event_id,export_row_id)
        SELECT e.owner_id,e.artifact_id,e.id,r.id FROM evidence_events e JOIN export_rows r
        ON r.artifact_id=e.artifact_id WHERE e.owner_id=:owner_id AND e.artifact_id=:artifact_id
        AND e.coverage='FILE' AND r.ordinal>:start ON CONFLICT DO NOTHING'''),
        {'owner_id': owner_id, 'artifact_id': artifact_id, 'start': start})


def resolve_evidence(db, user, body, clock):
    existing, digest = replay(db, user.id, EvidenceResolution, body)
    if existing:
        return existing
    check_snapshot(clock, body.expected_snapshot_version)
    entry = owned(db, user.id, RegistryEntry, body.entry_id)
    ids = set(body.evidence_ids)
    active = effective_event_ids(db, user.id, entry.id)
    if entry.external_state != 'CONFLICT' or ids != active or body.chosen_event_id not in ids:
        raise ApiError(409, 'resolution_coverage_conflict', 'Разрешение должно включать все текущие свидетельства конфликта этой записи.')
    chosen = owned(db, user.id, EvidenceEvent, body.chosen_event_id)
    if chosen.outcome not in ('APPLIED', 'REJECTED'):
        raise ApiError(422, 'resolution_outcome_unknown', 'Выберите свидетельство с известным исходом.')
    clock.version += 1
    resolution = EvidenceResolution(owner_id=user.id, entry_id=entry.id, chosen_event_id=chosen.id,
        reason=body.reason, operation_id=body.operation_id, request_digest=digest, snapshot_version=clock.version)
    db.add(resolution)
    db.flush()
    db.execute(insert(ResolutionEvidence), [{'owner_id': user.id, 'resolution_id': resolution.id,
                                          'event_id': event_id} for event_id in ids])
    refresh(db, user.id, entry_ids=[entry.id])
    for artifact_id in db.scalars(select(EvidenceEvent.artifact_id).where(EvidenceEvent.id.in_(ids)).distinct()):
        refresh_affected(db, user.id, artifact_id)
    return resolution


ROW_STATES_SQL = """
WITH claims AS (
 SELECT c.export_row_id, e.outcome, e.attempt_id FROM evidence_coverage c JOIN evidence_events e ON e.id=c.event_id
 JOIN export_rows r ON r.id=c.export_row_id
 WHERE r.owner_id=:owner_id AND r.id=ANY(:row_ids)
 AND NOT EXISTS (SELECT 1 FROM return_resolutions rr WHERE rr.previous_id=e.return_assessment_id)
 AND NOT EXISTS (SELECT 1 FROM evidence_resolutions s JOIN registry_entries re ON re.id=s.entry_id
                 JOIN resolution_evidence se ON se.resolution_id=s.id
                 WHERE re.owner_id=r.owner_id AND re.kind=r.kind AND re.business_key=r.business_key
                 AND se.event_id=e.id AND s.chosen_event_id<>e.id)
)
SELECT export_row_id, CASE WHEN bool_or(outcome='APPLIED') AND bool_or(outcome='REJECTED') THEN 'CONFLICT'
 WHEN bool_or(outcome='APPLIED') THEN 'APPLIED'
 WHEN bool_or(outcome='REJECTED') THEN 'REJECTED' ELSE 'UNKNOWN' END AS state
FROM claims c WHERE NOT EXISTS (
 SELECT 1 FROM claims newer JOIN attempt_ancestors aa ON aa.attempt_id=newer.attempt_id
 AND aa.ancestor_id=c.attempt_id WHERE newer.export_row_id=c.export_row_id AND newer.outcome='APPLIED')
GROUP BY export_row_id
"""


def row_states(db, owner_id, row_ids):
    if not row_ids:
        return {}
    return dict(db.execute(text(ROW_STATES_SQL), {'owner_id': owner_id, 'row_ids': row_ids}).all())
