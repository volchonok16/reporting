"""Bounded export indexing and deterministic SQL projections; timestamps never order effects."""
import csv
from uuid import uuid4, uuid5

from sqlalchemy import func, select, text, tuple_
from sqlalchemy.dialects.postgresql import insert

from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.operations import canonical_digest
from app.domain.output_spec import MANIFEST_VERSION, file_definition, manifest_spec
from app.errors import ApiError
from app.models import (Artifact, ArtifactSet, Case, ExportRow, OutputStage, RegistryBackfill,
                        RegistryClock, RegistryEntry, StageArtifact, User, utcnow)
from app.storage.artifact_sets import verify_artifact_set
from app.storage.local import StorageFailure
from app.storage.output_pages import preview_page


def owner_lock(db, owner_id):
    """All evidence/backfill writers serialize on one owner, including snapshot compare-and-set."""
    # User IDs are stable: exclude other writers, allow immutable child rows to reference their author.
    db.execute(select(User.id).where(User.id == owner_id).with_for_update(key_share=True))
    db.execute(insert(RegistryClock).values(owner_id=owner_id, version=0).on_conflict_do_nothing())
    return db.get(RegistryClock, owner_id)


def read_snapshot(db, owner_id):
    # Shared owner lock yields one consistent response without inserting projection metadata on GET.
    db.execute(select(User.id).where(User.id == owner_id).with_for_update(read=True))
    return db.scalar(select(RegistryClock.version).where(RegistryClock.owner_id == owner_id)) or 0


def entry_identity(owner_id, kind, key):
    return uuid5(owner_id, f'{kind}:{key}')


def ensure_entries(db, owner_id, keys):
    if keys:
        db.execute(insert(RegistryEntry).on_conflict_do_nothing(), [
            {'id': entry_identity(owner_id, kind, key), 'created_at': utcnow(), 'owner_id': owner_id,
             'kind': kind, 'business_key': key, 'prepared_count': 0, 'external_state': 'UNKNOWN'}
            for kind, key in keys])


def rebuild_batch(db, owner_id, after, size):
    query = select(ExportRow).where(ExportRow.owner_id == owner_id)
    if after:
        from app.domain.evidence import owned
        owned(db, owner_id, ExportRow, after)
        query = query.where(ExportRow.id > after)
    rows = list(db.scalars(query.order_by(ExportRow.id).limit(size + 1)))
    keys = {(row.kind, row.business_key) for row in rows[:size]}
    if keys:
        ensure_entries(db, owner_id, keys)
        refresh(db, owner_id, entry_ids=[entry_identity(owner_id, kind, key) for kind, key in keys])
    return rows[size - 1].id if len(rows) > size else None


def stages_for_bundle(db, bundle):
    """Extend historical ADD/DELETE with links without altering manifest or revision JSON."""
    stages = list(db.scalars(select(OutputStage).where(OutputStage.artifact_set_id == bundle.id)))
    if stages:
        return
    spec = manifest_spec(bundle.manifest)
    if spec['operation'] == 'CHANGE':
        raise StorageFailure()  # U9 publication already owns CHANGE links.
    if spec['operation'] == 'REPAIR':
        by_name = {}
        for definition in spec['stages']:
            if definition['id'] == 'DIAGNOSTIC':
                continue
            stage = OutputStage(case_id=bundle.case_id, revision_id=bundle.revision_id,
                artifact_set_id=bundle.id, name=definition['id'],
                depends_on_id=by_name[definition['depends_on'][0]].id if definition['depends_on'] else None)
            db.add(stage)
            db.flush()
            by_name[stage.name] = stage
            for artifact in db.scalars(select(Artifact).where(Artifact.artifact_set_id == bundle.id,
                                                             Artifact.role.in_(definition['roles']))):
                db.add(StageArtifact(artifact_set_id=bundle.id, stage_id=stage.id, artifact_id=artifact.id))
        db.flush()
        return
    stage = OutputStage(case_id=bundle.case_id, revision_id=bundle.revision_id,
                        artifact_set_id=bundle.id, name=spec['operation'])
    db.add(stage)
    db.flush()
    for artifact in db.scalars(select(Artifact).where(Artifact.artifact_set_id == bundle.id, Artifact.role != 'ZIP')):
        db.add(StageArtifact(artifact_set_id=bundle.id, stage_id=stage.id, artifact_id=artifact.id))
    db.flush()


def business_identity(role, values):
    if role == 'CLIENTS':
        kind, key = 'CLIENT', [values['INN']]
    elif role == 'DOGTAGS':
        kind, key = 'LABEL', [values['INN'], values['MAV_LABEL']]
    else:
        kind, key = 'ASSIGNMENT', [values['MSISDN']]
    return kind, canonical_digest(key)


def incomplete(db, owner_id):
    return db.scalar(select(func.count()).select_from(Artifact).join(ArtifactSet).join(Case)
        .outerjoin(RegistryBackfill, RegistryBackfill.artifact_id == Artifact.id)
        .where(Case.owner_id == owner_id, Artifact.role.not_in(('ZIP', 'ERRORS', 'ERROR_OTHER_OPERATOR')),
               (RegistryBackfill.artifact_id.is_(None)) | (RegistryBackfill.complete.is_(False))))


def backfill_batch(db, owner_id, storage, batch_size, artifact_id=None):
    """One file/one bounded batch per transaction; text seek cookies survive multiline CSV rows."""
    query = (select(Artifact, ArtifactSet).join(ArtifactSet).join(Case)
        .outerjoin(RegistryBackfill, RegistryBackfill.artifact_id == Artifact.id)
        .where(Case.owner_id == owner_id, Artifact.role.not_in(('ZIP', 'ERRORS', 'ERROR_OTHER_OPERATOR')),
               (RegistryBackfill.artifact_id.is_(None)) | (RegistryBackfill.complete.is_(False))))
    if artifact_id:
        query = query.where(Artifact.id == artifact_id)
    selected = db.execute(query.order_by(Artifact.id).limit(1)).first()
    if not selected:
        return None
    artifact, bundle = selected
    try:
        indexed = bundle.manifest['version'] == MANIFEST_VERSION
        verify_artifact_set(db, bundle, storage, full=not indexed)
        stages_for_bundle(db, bundle)
        job = db.get(RegistryBackfill, artifact.id)
        if not job:
            job = RegistryBackfill(artifact_id=artifact.id, owner_id=owner_id, case_id=bundle.case_id,
                                   artifact_set_id=bundle.id,
                                   expected_rows=bundle.manifest['counts'][artifact.role])
            db.add(job)
            db.flush()
        columns = file_definition(artifact.role, manifest_spec(bundle.manifest)['operation'])['columns']
        previous_cursor = job.cursor
        rows, at_end = read_batch(storage, bundle, artifact, job, columns, batch_size, indexed)
        pending = []
        for row in rows:
            if len(row) != len(columns):
                raise StorageFailure()
            values = dict(zip(columns, row, strict=True))
            kind, key = business_identity(artifact.role, values)
            job.cursor += 1
            pending.append({'id': uuid4(), 'created_at': utcnow(), 'owner_id': owner_id,
                'case_id': bundle.case_id, 'artifact_set_id': bundle.id, 'artifact_id': artifact.id,
                'ordinal': job.cursor, 'kind': kind, 'business_key': key, 'values': values})
        if pending:
            db.execute(insert(ExportRow), pending)
            keys = {(row['kind'], row['business_key']) for row in pending}
            ensure_entries(db, owner_id, keys)
        db.flush()
        if job.cursor > job.expected_rows:
            raise StorageFailure()
        if at_end:
            count = db.scalar(select(func.count()).select_from(ExportRow).where(ExportRow.artifact_id == artifact.id))
            if count != job.cursor or count != job.expected_rows:
                raise StorageFailure()
            job.complete = True
        db.flush()
        # Current rows can receive evidence while other rows/files remain under backfill.
        from app.domain.evidence import cover_backfilled_rows
        cover_backfilled_rows(db, owner_id, artifact.id, previous_cursor)
        if job.complete:
            refresh_affected(db, owner_id, artifact.id, backfill_completed=True)
        elif pending:
            ids = list(db.scalars(select(RegistryEntry.id).where(RegistryEntry.owner_id == owner_id,
                tuple_(RegistryEntry.kind, RegistryEntry.business_key).in_(keys))))
            refresh(db, owner_id, entry_ids=ids)
        return job
    except (StorageFailure, OSError, UnicodeError, csv.Error):
        raise ApiError(503, 'registry_integrity_error', 'История экспорта повреждена или недоступна.') from None


def read_batch(storage, bundle, artifact, job, columns, batch_size, indexed):
    if indexed:
        rows = []
        while len(rows) < batch_size:
            page = preview_page(storage, bundle.manifest['previews'][artifact.role], artifact.role,
                                after=job.cursor + len(rows), limit=min(200, batch_size - len(rows)))
            for row in page['items']:
                if row['page_index'] != job.cursor + len(rows) + 1:
                    raise StorageFailure()
                rows.append(row['values'])
            if page['next_cursor'] is None:
                return rows, True
        return rows, False
    # Legacy CSV has no trusted page index. Its old full verifier remains explicit above.
    ensure_csv_field_capacity(artifact.size_bytes)
    with storage.path_for_key(artifact.storage_key).open(encoding='cp1251', newline='') as stream:
        reader = csv.reader(iter(stream.readline, ''), delimiter=';', strict=True)
        if job.byte_cursor:
            stream.seek(job.byte_cursor)
        elif next(reader, None) != columns:
            raise StorageFailure()
        rows = []
        for _ in range(batch_size):
            row = next(reader, None)
            if row is None:
                break
            rows.append(row)
        job.byte_cursor = stream.tell()
        return rows, stream.read(1) == ''


# A resolution removes only the named evidence on this exact business entity. New evidence is
# still considered. Causal maximal successful effects win; unordered incompatible effects conflict.
CLAIMS_SQL = """
target AS (SELECT * FROM registry_entries WHERE owner_id = :owner_id {target}),
claims AS (
 SELECT DISTINCT t.id AS entry_id, e.id AS event_id, e.attempt_id, e.outcome,
        CASE WHEN a.role = 'DELETE' THEN 'DELETED' ELSE 'APPLIED' END AS effect,
        CASE WHEN a.role = 'DELETE' THEN 'DELETE' ELSE r.values::text END AS signature,
        x.stage_id, r.values AS export_values,
        EXISTS (SELECT 1 FROM evidence_resolutions s WHERE s.entry_id = t.id
                  AND s.chosen_event_id = e.id) AS reconciled
 FROM target t JOIN export_rows r ON r.owner_id=t.owner_id AND r.kind=t.kind AND r.business_key=t.business_key
 JOIN evidence_coverage c ON c.export_row_id=r.id
 JOIN evidence_events e ON e.id=c.event_id
 JOIN external_attempts x ON x.id=e.attempt_id
 JOIN artifacts a ON a.id=r.artifact_id
 WHERE NOT EXISTS (SELECT 1 FROM return_resolutions rr WHERE rr.previous_id=e.return_assessment_id)
 AND NOT EXISTS (
   SELECT 1 FROM evidence_resolutions s JOIN resolution_evidence se ON se.resolution_id=s.id
   WHERE s.entry_id=t.id AND se.event_id=e.id AND s.chosen_event_id<>e.id)
),
maximal AS (
 SELECT c.* FROM claims c WHERE NOT EXISTS (
   SELECT 1 FROM claims newer JOIN attempt_ancestors aa
     ON aa.attempt_id=newer.attempt_id AND aa.ancestor_id=c.attempt_id
   WHERE newer.entry_id=c.entry_id AND newer.outcome='APPLIED')
),
states AS (
 SELECT t.id,
 CASE
 WHEN EXISTS (SELECT 1 FROM maximal c JOIN maximal other ON c.entry_id=other.entry_id
              AND c.attempt_id=other.attempt_id WHERE c.entry_id=t.id
              AND c.outcome='APPLIED' AND other.outcome='REJECTED') THEN 'CONFLICT'
 WHEN (SELECT count(DISTINCT signature) FROM maximal WHERE entry_id=t.id AND outcome='APPLIED')>1 THEN 'CONFLICT'
 WHEN EXISTS (
   SELECT 1 FROM maximal c JOIN external_attempts current_attempt ON current_attempt.id=c.attempt_id
   JOIN artifact_sets current_bundle ON current_bundle.id=current_attempt.artifact_set_id
   JOIN output_stages stage ON stage.id=c.stage_id
   JOIN stage_artifacts required_link ON required_link.artifact_set_id=current_attempt.artifact_set_id
   JOIN artifacts required ON required.id=required_link.artifact_id
   JOIN artifacts current_file ON current_file.id=current_attempt.artifact_id
   WHERE c.entry_id=t.id AND c.outcome='APPLIED' AND NOT c.reconciled
     AND (required_link.stage_id=stage.depends_on_id OR
       (required_link.stage_id=stage.id AND
          array_position(ARRAY['CLIENTS','DOGTAGS','NUMBERS'],required.role)
          < array_position(ARRAY['CLIENTS','DOGTAGS','NUMBERS'],current_file.role)))
     -- Recovery files contain only the missing business rows. An unrelated
     -- CLIENTS/DOGTAGS row is not a prerequisite for another row's main import.
     -- The complete preceding DELETE stage and historical ADD/CHANGE stay strict.
     AND (required_link.stage_id=stage.depends_on_id
       OR current_bundle.manifest->'output_spec'->>'operation' IS DISTINCT FROM 'REPAIR'
       OR NOT EXISTS (SELECT 1 FROM registry_backfills indexed
         WHERE indexed.artifact_id=required.id AND indexed.complete)
       OR EXISTS (SELECT 1 FROM export_rows related WHERE related.artifact_id=required.id
         AND related.values->>'INN'=c.export_values->>'INN'
         AND (required.role='CLIENTS' OR related.values->>'MAV_LABEL'=c.export_values->>'MAV_LABEL_NAME')))
     AND NOT EXISTS (
       SELECT 1 FROM attempt_ancestors aa JOIN external_attempts prior ON prior.id=aa.ancestor_id
       JOIN registry_backfills b ON b.artifact_id=prior.artifact_id AND b.complete
       WHERE aa.attempt_id=c.attempt_id AND prior.artifact_id=required.id
       AND EXISTS (SELECT 1 FROM export_rows pr WHERE pr.artifact_id=prior.artifact_id
         AND (required.role='DELETE' OR (pr.values->>'INN'=c.export_values->>'INN'
           AND (required.role='CLIENTS' OR pr.values->>'MAV_LABEL'=c.export_values->>'MAV_LABEL_NAME'))))
       AND NOT EXISTS (
         SELECT 1 FROM export_rows pr WHERE pr.artifact_id=prior.artifact_id
         AND (required.role='DELETE' OR (pr.values->>'INN'=c.export_values->>'INN'
           AND (required.role='CLIENTS' OR pr.values->>'MAV_LABEL'=c.export_values->>'MAV_LABEL_NAME')))
         AND (
           NOT EXISTS (SELECT 1 FROM evidence_coverage pc JOIN evidence_events pe ON pe.id=pc.event_id
                       WHERE pc.export_row_id=pr.id AND pe.attempt_id=prior.id AND pe.outcome='APPLIED'
                       AND NOT EXISTS (SELECT 1 FROM return_resolutions rr WHERE rr.previous_id=pe.return_assessment_id)
                       AND NOT EXISTS (SELECT 1 FROM evidence_resolutions s JOIN registry_entries re ON re.id=s.entry_id
                         JOIN resolution_evidence se ON se.resolution_id=s.id
                         WHERE re.owner_id=pr.owner_id AND re.kind=pr.kind AND re.business_key=pr.business_key
                           AND se.event_id=pe.id AND s.chosen_event_id<>pe.id))
           OR EXISTS (SELECT 1 FROM evidence_coverage pc JOIN evidence_events pe ON pe.id=pc.event_id
                       WHERE pc.export_row_id=pr.id AND pe.attempt_id=prior.id AND pe.outcome='REJECTED'
                       AND NOT EXISTS (SELECT 1 FROM return_resolutions rr WHERE rr.previous_id=pe.return_assessment_id)
                       AND NOT EXISTS (SELECT 1 FROM evidence_resolutions s JOIN registry_entries re ON re.id=s.entry_id
                         JOIN resolution_evidence se ON se.resolution_id=s.id
                         WHERE re.owner_id=pr.owner_id AND re.kind=pr.kind AND re.business_key=pr.business_key
                           AND se.event_id=pe.id AND s.chosen_event_id<>pe.id))
         )
       )
     )
 ) THEN 'CONFLICT' 
 WHEN EXISTS (SELECT 1 FROM maximal WHERE entry_id=t.id AND outcome='APPLIED' AND effect='DELETED') THEN 'DELETED'
 WHEN EXISTS (SELECT 1 FROM maximal WHERE entry_id=t.id AND outcome='APPLIED') THEN 'APPLIED'
 WHEN EXISTS (SELECT 1 FROM maximal WHERE entry_id=t.id AND outcome='REJECTED') THEN 'REJECTED'
 ELSE 'UNKNOWN' END AS external_state,
 (SELECT count(*) FROM export_rows r JOIN registry_backfills b ON b.artifact_id=r.artifact_id AND b.complete
   WHERE r.owner_id=t.owner_id AND r.kind=t.kind AND r.business_key=t.business_key) AS prepared_count
 FROM target t
)
"""


def refresh_affected(db, owner_id, artifact_id, *, backfill_completed=False):
    # The changed artifact and causally downstream stages may concern different business keys.
    target = '''AND (kind,business_key) IN (
        SELECT kind,business_key FROM export_rows WHERE artifact_id=:artifact_id
        UNION SELECT r.kind,r.business_key FROM external_attempts original
        JOIN attempt_ancestors aa ON aa.ancestor_id=original.id
        JOIN external_attempts downstream ON downstream.id=aa.attempt_id
        JOIN export_rows r ON r.artifact_id=downstream.artifact_id
        WHERE original.artifact_id=:artifact_id AND original.owner_id=:owner_id'''
    if backfill_completed:
        # A complete recovery index can prove that an earlier file has no related
        # row, even when that file was never submitted and has no attempt edges.
        target += ''' UNION SELECT r.kind,r.business_key FROM artifacts indexed
            JOIN artifact_sets bundle ON bundle.id=indexed.artifact_set_id
            JOIN export_rows r ON r.artifact_set_id=bundle.id AND r.owner_id=:owner_id
            WHERE indexed.id=:artifact_id
              AND indexed.role IN ('CLIENTS','DOGTAGS')
              AND bundle.manifest->'output_spec'->>'operation'='REPAIR' '''
    target += ')'
    apply_projection(db, target, {'owner_id': owner_id, 'artifact_id': artifact_id})


def refresh(db, owner_id, *, artifact_id=None, entry_ids=None):
    target, parameters = '', {'owner_id': owner_id}
    if entry_ids is not None:
        if not entry_ids:
            return
        target = 'AND id = ANY(:entry_ids)'
        parameters['entry_ids'] = entry_ids
    elif artifact_id:
        target = ('AND (kind,business_key) IN (SELECT kind,business_key FROM export_rows '
                  'WHERE artifact_id=:artifact_id)')
        parameters['artifact_id'] = artifact_id
    apply_projection(db, target, parameters)


def apply_projection(db, target, parameters):
    db.execute(text('WITH ' + CLAIMS_SQL.format(target=target) + '''
        UPDATE registry_entries t SET external_state=s.external_state, prepared_count=s.prepared_count
        FROM states s WHERE t.id=s.id
        AND (t.external_state,t.prepared_count) IS DISTINCT FROM (s.external_state,s.prepared_count)'''), parameters)
    db.expire_all()


def effective_event_ids(db, owner_id, entry_id):
    return set(db.scalars(text('WITH ' + CLAIMS_SQL.format(target='AND id=:entry_id') +
        'SELECT DISTINCT event_id FROM maximal'), {'owner_id': owner_id, 'entry_id': entry_id}))
