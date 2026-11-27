"""Exact STATUS matching in the shared DISCOVER slot, with immutable fenced publication."""
import json
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4, uuid5

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

from app.domain.evidence import owned
from app.domain.operations import canonical_digest
from app.domain.output_spec import file_definition, manifest_spec
from app.domain.readers.base import indexed_record_id, raw_rows, read_raw_index
from app.domain.readers.mapping import map_columns
from app.domain.registry import backfill_batch, business_identity, owner_lock, refresh_affected
from app.domain.rules import checked_config
from app.errors import ApiError
from app.models import (Artifact, ArtifactSet, EvidenceEvent, ExportRow, ExternalAttempt, IntakeVersion,
                        ProcessingRevision, ReturnAssessment, ReturnResolution, ReturnRow, utcnow)


def select_return(db, user, intake, choices):
    previous = db.get(IntakeVersion, intake.current_version_id)
    attempt_id = choices.get('return_attempt_id', previous.decisions.get('return_attempt_id'))
    latest = db.scalar(select(ReturnAssessment).join(IntakeVersion,
        IntakeVersion.id == ReturnAssessment.intake_version_id).where(ReturnAssessment.intake_id == intake.id)
        .order_by(IntakeVersion.sequence.desc()).limit(1))
    if attempt_id:
        owned(db, user.id, ExternalAttempt, UUID(attempt_id))
        if choices.get('operation', 'STATUS') != 'STATUS':
            raise ApiError(422, 'return_operation_invalid', 'Связь с попыткой требует назначения STATUS.')
        choices['operation'] = 'STATUS'
    if latest:
        if not (choices.get('reason') or '').strip():
            raise ApiError(422, 'return_resolution_reason_required', 'Укажите основание пересмотра использованной сверки.')
        choices['replaces_return_assessment_id'] = str(latest.id)
    return choices


def return_context(db, version):
    selected = version.decisions.get('return_attempt_id')
    if not selected:
        return None
    attempt = owned(db, version.created_by, ExternalAttempt, UUID(selected))
    artifact = db.get(Artifact, attempt.artifact_id)
    bundle = db.get(ArtifactSet, attempt.artifact_set_id)
    revision = db.get(ProcessingRevision, bundle.revision_id)
    columns = file_definition(artifact.role, manifest_spec(bundle.manifest)['operation'])['columns']
    return {'attempt_id': str(attempt.id), 'artifact_id': str(artifact.id), 'role': artifact.role,
            'stage_id': str(attempt.stage_id), 'artifact_set_id': str(bundle.id),
            'manifest_hash': bundle.manifest_hash, 'columns': columns,
            'profile_snapshot': revision.profile_snapshot}


def configure_return(result, questions, decisions, aliases, context):
    """One role-specific decision; no unrelated ADD mapping or partner requirement."""
    questions[:] = [q for q in questions if q['field'] not in ('partner', 'mapping', 'operation')]
    if not context:
        questions.append({'field': 'return_attempt_id', 'code': 'return_correlation_required',
            'message': 'Выберите выданный CSV и внешнюю попытку. Если попытка ещё не записана, создайте её для этого CSV.'})
        return
    result['return_context'] = context
    required = [*context['columns'], 'STATUS']
    mapped = map_columns(result['columns'], aliases, required)
    mapping = decisions.get('mapping') if decisions.get('mapping') is not None else mapped['mapping']
    complete = (set(mapping) == set(required) and len(set(mapping.values())) == len(mapping)
                and all(type(i) is int and 0 <= i < len(result['columns']) for i in mapping.values()))
    result.update(mapping=mapping, mapping_analysis=mapped)
    if not complete:
        questions.append({'field': 'mapping', 'code': 'return_mapping_required',
            'message': 'Укажите колонки выданной роли и STATUS для точного сопоставления.',
            'required': required, 'columns': result['columns']})


def scratch_database(path):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript('''PRAGMA temp_store=FILE;
        CREATE TABLE exports (id TEXT PRIMARY KEY, ordinal INTEGER, business_key TEXT, signature TEXT);
        CREATE INDEX exports_match ON exports(business_key,signature);
        CREATE TABLE rows (ordinal INTEGER PRIMARY KEY, raw_record_id TEXT, raw_cells TEXT,
            raw_status TEXT, export_row_id TEXT, classification TEXT, reason TEXT);
        CREATE INDEX rows_export ON rows(export_row_id,classification);''')
    return db


def match_row(scratch, role, values, raw_status, rules, issues):
    if issues:
        return None, 'INVALID', 'raw_cell_uncertain'
    _, key = business_identity(role, values)
    matches = scratch.execute('SELECT id FROM exports WHERE business_key=? AND signature=? LIMIT 2',
                              (key, canonical_digest(values))).fetchall()
    if len(matches) != 1:
        return None, ('AMBIGUOUS' if matches else 'UNMATCHED'), ('multiple_exact_exports' if matches else 'no_exact_export')
    outcome = {'success': 'APPLIED', 'failure': 'REJECTED'}.get(rules.get(raw_status), 'UNKNOWN')
    return matches[0]['id'], outcome, 'known_status' if outcome != 'UNKNOWN' else 'unknown_status'


def reconcile_scratch(scratch):
    scratch.execute("""UPDATE rows SET classification='CONFLICT',reason='contradictory_repeats'
        WHERE export_row_id IN (SELECT export_row_id FROM rows WHERE export_row_id IS NOT NULL
        GROUP BY export_row_id HAVING count(DISTINCT classification)>1)""")
    offset = scratch.execute('SELECT coalesce(max(ordinal),0) FROM rows').fetchone()[0]
    scratch.execute("""INSERT INTO rows
        SELECT ? + row_number() OVER (ORDER BY e.ordinal), NULL, '[]', NULL, e.id, 'MISSING','missing_coverage'
        FROM exports e WHERE NOT EXISTS (SELECT 1 FROM rows r WHERE r.export_row_id=e.id)""", (offset,))
    scratch.commit()
    return dict(scratch.execute('SELECT classification,count(*) FROM rows GROUP BY classification').fetchall())


def assess_return(sessions, version, result, storage, directory, checkpoint):
    context = result['return_context']
    owner_id, artifact_id = version.created_by, UUID(context['artifact_id'])
    # Reuse the durable U10 cursor; each bounded batch releases its owner transaction.
    while True:
        checkpoint()
        with sessions() as db, db.begin():
            clock = owner_lock(db, owner_id)
            job = backfill_batch(db, owner_id, storage, 1000, artifact_id)
            if job:
                clock.version += 1
            if job is None or job.complete:
                break
    path = Path(directory) / 'return-matches.sqlite'
    scratch = scratch_database(path)
    try:
        after = 0
        while True:
            checkpoint()
            with sessions() as db:
                batch = list(db.scalars(select(ExportRow).where(ExportRow.artifact_id == artifact_id,
                    ExportRow.owner_id == owner_id, ExportRow.ordinal > after).order_by(ExportRow.ordinal).limit(1000)))
                if not batch:
                    break
                scratch.executemany('INSERT INTO exports VALUES (?,?,?,?)',
                    [(str(r.id), r.ordinal, r.business_key, canonical_digest(r.values)) for r in batch])
                after = batch[-1].ordinal
            scratch.commit()
        index = read_raw_index(storage, result['raw_index_key'])
        rules = {r['value']: r['classification'] for r in checked_config(version.decisions['rules_snapshot'])['statuses']}
        for row in raw_rows(storage, index):
            if row['ordinal'] % 1000 == 1:
                checkpoint()
                scratch.commit()
            mapping, cells = result['mapping'], row['cells']
            values = {field: cells[i] if i < len(cells) else '' for field, i in mapping.items() if field != 'STATUS'}
            status_column = mapping['STATUS']
            status = cells[status_column] if status_column < len(cells) else ''
            issues = [issue for issue in row['issues'] if 'column' not in issue or issue['column'] in mapping.values()]
            match, outcome, reason = match_row(scratch, context['role'], values, status, rules, issues)
            scratch.execute('INSERT INTO rows VALUES (?,?,?,?,?,?,?)', (row['ordinal'],
                indexed_record_id(version.source_asset_id, index['table_id'], row['row_number']),
                json.dumps(cells, ensure_ascii=False), status, match, outcome, reason))
        counts = reconcile_scratch(scratch)
        return {'path': str(path), 'counts': counts}
    finally:
        scratch.close()


def publish_return(db, version, assessment, prepared):
    """Called only inside fenced DISCOVER completion; all evidence and resolution are atomic."""
    context, snapshot = assessment.result['return_context'], version.decisions['rules_snapshot']
    owner_id, artifact_id = version.created_by, UUID(context['artifact_id'])
    clock = owner_lock(db, owner_id)
    obj = ReturnAssessment(owner_id=owner_id, case_id=version.case_id, intake_id=version.intake_id,
        source_asset_id=version.source_asset_id, intake_version_id=version.id, assessment_id=assessment.id,
        artifact_id=artifact_id, attempt_id=UUID(context['attempt_id']), rule_version=snapshot['version'],
        rule_digest=snapshot['digest'], counts=prepared['counts'])
    db.add(obj)
    db.flush()
    with sqlite3.connect(prepared['path']) as scratch:
        scratch.row_factory = sqlite3.Row
        cursor = scratch.execute('SELECT * FROM rows ORDER BY ordinal')
        while batch := cursor.fetchmany(1000):
            db.execute(insert(ReturnRow), [{'id': uuid4(), 'created_at': utcnow(), 'owner_id': owner_id,
                'artifact_id': artifact_id, 'return_assessment_id': obj.id, 'ordinal': r['ordinal'],
                'raw_record_id': UUID(r['raw_record_id']) if r['raw_record_id'] else None,
                'raw_cells': json.loads(r['raw_cells']), 'raw_status': r['raw_status'],
                'export_row_id': UUID(r['export_row_id']) if r['export_row_id'] else None,
                'classification': r['classification'], 'reason': r['reason']} for r in batch])
    clock.version += 1
    old_id = version.decisions.get('replaces_return_assessment_id')
    previous_artifact = None
    if old_id:
        old = db.get(ReturnAssessment, UUID(old_id))
        previous_artifact = old.artifact_id
        db.add(ReturnResolution(owner_id=owner_id, intake_id=version.intake_id, previous_id=old.id,
            replacement_id=obj.id, reason=version.decisions['reason'], snapshot_version=clock.version))
        db.flush()
    for outcome in ('APPLIED', 'REJECTED'):
        if not prepared['counts'].get(outcome):
            continue
        event = EvidenceEvent(owner_id=owner_id, artifact_id=artifact_id, attempt_id=obj.attempt_id,
            author_id=owner_id, reason=f'STATUS correlation {obj.id}; rule {snapshot["version"]}',
            origin='RETURN', source_case_id=obj.case_id, source_asset_id=obj.source_asset_id,
            return_assessment_id=obj.id, outcome=outcome, coverage='ROWS',
            operation_id=uuid5(obj.id, outcome), request_digest=canonical_digest({'assessment': str(obj.id), 'outcome': outcome}),
            snapshot_version=clock.version)
        db.add(event)
        db.flush()
        db.execute(text('''INSERT INTO evidence_coverage (owner_id,artifact_id,event_id,export_row_id)
            SELECT DISTINCT owner_id,artifact_id,:event_id,export_row_id FROM return_rows
            WHERE return_assessment_id=:assessment AND classification=:outcome'''),
            {'event_id': event.id, 'assessment': obj.id, 'outcome': outcome})
    refresh_affected(db, owner_id, artifact_id)
    if previous_artifact and previous_artifact != artifact_id:
        refresh_affected(db, owner_id, previous_artifact)
    return obj


def finish_return(sessions, lease, data):
    """Stage uncommitted history without blocking heartbeat; fence only the small commit tail.

    Case/User NO KEY UPDATE serialization is compatible with child FK KEY SHARE. No Case,
    Intake or Run is changed until all heavy row/coverage/projection work has completed.
    A concurrent decision or recovered generation makes the entire transaction roll back.
    """
    from app.models import Intake, IntakeAssessment, ProcessingRun
    from app.processing.leases import audit, clear_lease, database_now, locked_run, owns_lease
    with sessions() as db, db.begin():
        run = db.get(ProcessingRun, lease.run_id)
        if not owns_lease(run, lease, database_now(db)):
            return False
        version = db.get(IntakeVersion, run.intake_version_id)
        assessment = IntakeAssessment(case_id=version.case_id, intake_id=version.intake_id,
            source_asset_id=version.source_asset_id, intake_version_id=version.id,
            **{k: v for k, v in data.items() if k != 'prepared_return'})
        db.add(assessment)
        db.flush()
        publish_return(db, version, assessment, data['prepared_return'])
        # The first reads are no longer authority after a long publication transaction.
        db.expire_all()
        case, run = locked_run(db, lease.run_id)
        intake = db.get(Intake, version.intake_id)
        if (not owns_lease(run, lease, database_now(db)) or intake.current_version_id != version.id
                or case.head_revision_id is not None):
            db.rollback()
            return False
        intake.current_assessment_id = assessment.id
        intake.state = 'NEEDS_DECISION' if assessment.questions else 'RECONCILED'
        run.summary = {'assessment_id': str(assessment.id), 'question_count': len(assessment.questions)}
        run.progress = {'stage': 'complete', 'percent': 100}
        run.state = 'COMPLETE'
        clear_lease(run)
        audit(db, run, 'discovery.completed', {'assessment_id': str(assessment.id), 'state': intake.state})
        return True
