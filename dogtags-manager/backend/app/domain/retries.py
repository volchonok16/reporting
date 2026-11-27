"""Pinned corrected retry selection, exact dependency versions and evidence release fences."""
import json
from copy import deepcopy
from uuid import UUID

from sqlalchemy import func, select, text

from app.domain.canonical import connection, read_dataset_index, sql_path
from app.domain.operations import canonical_digest, complete_operation, find_operation
from app.domain.output_spec import dataset_operation, file_definition, output_spec, retry_spec
from app.domain.registry import CLAIMS_SQL, read_snapshot
from app.errors import ApiError
from app.models import (Artifact, ArtifactSet, Case, Operation, ProcessingRevision, ProcessingRun,
                        EvidenceEvent, EvidenceResolution, ExportRow, ExternalAttempt, RegistryBackfill,
                        ReturnResolution, SourceAsset)

RETRY_VERSION = 'corrected-retry-v1'


def uses_delete_stage(revision, role):
    return role == 'DELETE' and (revision.settings.get('operation') == 'CHANGE'
                                or revision.settings.get('retry', {}).get('stage_source', False))

# An exact attempt result is separate from the causal state of the business entity.
ATTEMPT_ROWS = """SELECT r.id,r.ordinal,r.values,
 CASE WHEN bool_or(e.outcome='APPLIED') AND bool_or(e.outcome='REJECTED') THEN 'CONFLICT'
 WHEN bool_or(e.outcome='APPLIED') THEN 'APPLIED' WHEN bool_or(e.outcome='REJECTED') THEN 'REJECTED'
 ELSE 'UNKNOWN' END AS state
 FROM export_rows r LEFT JOIN evidence_coverage c ON c.export_row_id=r.id
 LEFT JOIN evidence_events e ON e.id=c.event_id AND e.attempt_id=:attempt
 AND NOT EXISTS (SELECT 1 FROM return_resolutions rr WHERE rr.previous_id=e.return_assessment_id)
 AND NOT EXISTS (SELECT 1 FROM evidence_resolutions s JOIN registry_entries re ON re.id=s.entry_id
 JOIN resolution_evidence se ON se.resolution_id=s.id WHERE re.owner_id=r.owner_id
 AND re.kind=r.kind AND re.business_key=r.business_key AND se.event_id=e.id AND s.chosen_event_id<>e.id)
 WHERE r.owner_id=:owner AND r.artifact_id=:artifact GROUP BY r.id ORDER BY r.ordinal"""


def evidence_watermark(db, owner_id):
    # These three histories are append-only. Projection/backfill movement is not new external evidence.
    return {model.__tablename__: db.scalar(select(func.count()).select_from(model).where(model.owner_id == owner_id))
            for model in (EvidenceEvent, EvidenceResolution, ReturnResolution)}


def snapshot_current(db, owner_id, revision):
    retry = revision.settings.get('retry')
    if not retry:
        return True
    read_snapshot(db, owner_id)
    return evidence_watermark(db, owner_id) == retry['evidence_watermark']


def require_snapshot(db, owner_id, revision):
    if not snapshot_current(db, owner_id, revision):
        raise ApiError(409, 'evidence_snapshot_changed',
                       'Свидетельства изменились. Пересчитайте повтор и подтвердите новый комплект.')


def create_retry(db, user, assessment, body, storage):
    """Short command: source-cell reads happen outside owner/Case locks; BUILD owns global work."""
    from app.api.processing import enqueue, receipt
    from app.api.schemas import SaveRevisionBody
    from app.api.views import revision_view
    from app.auth.policy import owned_case, scoped_object
    from app.domain.readers.dispatch import reader_result
    from app.domain.revisions import append_revision, source_records
    bundle = db.get(ArtifactSet, db.get(Artifact, assessment.artifact_id).artifact_set_id)
    original = db.get(ProcessingRevision, bundle.revision_id)
    case_id = original.case_id
    digest = canonical_digest(body.model_dump(mode='json', exclude={'operation_id'}))
    existing = find_operation(db, user.id, case_id, 'return.retry', body.operation_id, digest)
    if existing:
        return existing
    previous = original
    if body.retry_revision_id:
        previous = scoped_object(db, user, ProcessingRevision, body.retry_revision_id, case_id=case_id)
        if previous.settings.get('retry', {}).get('assessment_id') != str(assessment.id):
            raise ApiError(409, 'retry_source_conflict', 'Ревизия повтора относится к другой сверке.')
    source = db.get(SourceAsset, original.source_asset_id)
    info = {k: getattr(source, k) for k in ('id', 'storage_key', 'sha256', 'size_bytes', 'encoding')}
    info.update(reader_result=reader_result(db, original), rules_snapshot=original.settings.get('rules_snapshot'))
    overlay = deepcopy(previous.correction_overlay)
    source_id, previous_id, original_id, assessment_id = source.id, previous.id, original.id, assessment.id
    artifact_id, attempt_id = assessment.artifact_id, assessment.attempt_id
    role = db.get(Artifact, artifact_id).role
    stage_source = uses_delete_stage(original, role)
    stage_corrections = (deepcopy(previous.settings.get('retry', {}).get('stage_corrections', []))
                         if stage_source and body.retry_revision_id else [])
    if stage_source:
        from app.domain.corrections import effective_values
        from app.models import utcnow
        from app.domain.ingress import SourceRecord
        for change in body.corrections:
            row = db.get(ExportRow, change.record_id)
            if not row or row.artifact_id != artifact_id or row.ordinal != change.ordinal or change.field != 'MSISDN':
                raise ApiError(422, 'retry_correction_scope', 'Исправьте точную строку DELETE-артефакта.')
            record = SourceRecord(str(row.id), row.ordinal, row.ordinal + 1, row.ordinal + 1,
                                  [row.values['MSISDN']], row.values, [], {'MSISDN': 0})
            values = effective_values(record, [c for c in stage_corrections if c['record_id'] == str(row.id)])
            if values['MSISDN'] != change.before:
                raise ApiError(409, 'before_value_conflict', 'Значение строки DELETE изменилось.')
            stage_corrections.append({**change.model_dump(mode='json'), 'author_id': str(user.id),
                'created_at': utcnow().isoformat(), 'source_asset_id': str(source_id), 'rule_version': 'manual-v1',
                'mapping_digest': canonical_digest({'artifact_id': str(artifact_id)})})
    db.rollback()
    records = {} if stage_source else source_records(storage, info, overlay, body.corrections)
    snapshot = read_snapshot(db, user.id)  # Always owner -> Case -> Run, including release paths.
    case = owned_case(db, user, case_id, permission_name='case.edit', lock=True)
    existing = find_operation(db, user.id, case_id, 'return.retry', body.operation_id, digest)
    if existing:
        return existing
    if snapshot != body.expected_snapshot_version:
        raise ApiError(409, 'evidence_snapshot_changed', 'Перечитайте внешние свидетельства перед пересчётом.')
    if db.scalar(select(ReturnResolution.id).where(ReturnResolution.previous_id == assessment_id)):
        raise ApiError(409, 'return_assessment_superseded', 'Эта сверка заменена новой версией.')
    if case.head_revision_id is None:
        raise ApiError(409, 'revision_conflict', 'Дождитесь завершения распознавания исходного файла.')
    head = db.get(ProcessingRevision, case.head_revision_id)
    previous = db.get(ProcessingRevision, previous_id)
    source = db.get(SourceAsset, source_id)
    retry = {'version': RETRY_VERSION, 'assessment_id': str(assessment_id), 'attempt_id': str(attempt_id),
             'artifact_id': str(artifact_id), 'source_revision_id': str(original_id),
             'snapshot_version': snapshot, 'evidence_watermark': evidence_watermark(db, user.id),
             'role': role, 'reason': body.reason,
             'success_reasons': {str(k): v for k, v in body.success_reasons.items()}}
    if stage_source:
        retry.update(stage_source=True, stage_corrections=stage_corrections)
    operation = 'DELETE' if role == 'DELETE' else 'ADD'
    saved = SaveRevisionBody(operation_id=body.operation_id, expected_revision_id=body.expected_revision_id,
                             source_asset_id=source_id, corrections=[] if stage_source else body.corrections)
    revision = append_revision(db, user, case, previous, source, saved, records,
        settings_updates={'retry': retry, 'operation': operation, 'output_spec': output_spec(operation)},
        sequence=head.sequence + 1)
    command = Operation(owner_id=user.id, case_id=case.id, action='return.retry',
                        client_operation_id=body.operation_id, request_digest=digest)
    db.add(command)
    db.flush()
    complete_operation(command, {'revision': revision_view(revision, source)})
    receipt(db, user, command, enqueue(db, revision))
    return command


def retry_paths(storage, run):
    index = read_dataset_index(storage, run.dataset_key)
    return {role: storage.verify(obj['key'], obj['sha256'], obj['size_bytes'])
            for role, obj in index['objects'].items()}


def load_rows(db, query, parameters, work, table, fields, transform):
    """Server cursor -> bounded batches -> disk-backed DuckDB; no unbounded Python row list."""
    for batch in db.execute(text(query), parameters, execution_options={'yield_per': 500}).partitions(500):
        work.executemany(f'INSERT INTO {table} VALUES ({",".join("?" for _ in fields)})',
                         [transform(row) for row in batch])


def prepare_retry(sessions, revision, storage, directory, memory_limit, threads, checkpoint):
    """Build the closure against serialized versions, retaining a decision for every export row."""
    from app.domain.registry import backfill_batch, owner_lock
    retry = revision.settings['retry']
    role = retry['role']
    with sessions() as db:
        owner = db.get(Case, revision.case_id).owner_id
        original_run = db.scalar(select(ProcessingRun).where(
            ProcessingRun.revision_id == UUID(retry['source_revision_id'])))
        paths = retry_paths(storage, original_run)
    # Complete submitted histories before selection, in bounded transactions. Backfill does not
    # change the immutable evidence watermark captured by the command.
    after = None
    while True:
        with sessions() as db:
            query = (select(ExternalAttempt.artifact_id)
                .outerjoin(RegistryBackfill, RegistryBackfill.artifact_id == ExternalAttempt.artifact_id)
                .where(ExternalAttempt.owner_id == owner,
                       RegistryBackfill.artifact_id.is_(None) | RegistryBackfill.complete.is_(False)).distinct())
            if after:
                query = query.where(ExternalAttempt.artifact_id > after)
            ids = list(db.scalars(query.order_by(ExternalAttempt.artifact_id).limit(100)))
        if not ids:
            break
        for artifact_id in ids:
            while True:
                with sessions() as db, db.begin():
                    clock = owner_lock(db, owner)
                    job = backfill_batch(db, owner, storage, 500, artifact_id)
                    if job:
                        clock.version += 1
                    done = job is None or job.complete
                checkpoint()
                if done:
                    break
        after = ids[-1]
    with connection(directory / 'retry.duckdb', memory_limit=memory_limit, threads=threads,
                    temp_directory=directory / '.retry-spill') as work:
        work.execute('CREATE TABLE decisions (export_row_id VARCHAR, export_ordinal BIGINT, values_json JSON, '
                     'state VARCHAR, reason VARCHAR, selected BOOLEAN, page_index BIGINT)')
        work.execute('CREATE TABLE applied (role VARCHAR, values_json JSON, state VARCHAR, event_id VARCHAR, attempt_id VARCHAR)')
        work.execute('CREATE TABLE unresolved (role VARCHAR, values_json JSON, state VARCHAR)')
        with sessions() as db:
            require_snapshot(db, owner, revision)
            reasons = retry['success_reasons']
            load_rows(db, ATTEMPT_ROWS, {'owner': owner, 'artifact': UUID(retry['artifact_id']),
                'attempt': UUID(retry['attempt_id'])}, work, 'decisions', range(7),
                lambda r: (str(r.id), r.ordinal, json.dumps(r.values), r.state,
                    reasons.get(str(r.id), 'rejected' if r.state == 'REJECTED' else r.state.lower()),
                    r.state == 'REJECTED' or r.state == 'APPLIED' and str(r.id) in reasons, r.ordinal))
            # Exact surviving causal versions only. A same-INN older success cannot satisfy a changed label.
            query = 'WITH ' + CLAIMS_SQL.format(target='') + """SELECT DISTINCT a.role,m.export_values,s.external_state,m.event_id,m.attempt_id
                FROM maximal m JOIN states s ON s.id=m.entry_id JOIN external_attempts x ON x.id=m.attempt_id
                JOIN artifacts a ON a.id=x.artifact_id WHERE m.outcome='APPLIED'"""
            load_rows(db, query, {'owner_id': owner}, work, 'applied', range(5),
                      lambda r: (r.role, json.dumps(r.export_values), r.external_state, str(r.event_id), str(r.attempt_id)))
            query = '''SELECT DISTINCT a.role,r.values,re.external_state FROM external_attempts x
                JOIN export_rows r ON r.artifact_id=x.artifact_id JOIN artifacts a ON a.id=x.artifact_id
                JOIN registry_entries re ON re.owner_id=r.owner_id AND re.kind=r.kind AND re.business_key=r.business_key
                WHERE x.owner_id=:owner_id AND re.external_state IN ('UNKNOWN','CONFLICT')'''
            load_rows(db, query, {'owner_id': owner}, work, 'unresolved', range(3),
                      lambda r: (r.role, json.dumps(r.values), r.external_state))
        checkpoint()
        fields = file_definition(role, 'DELETE' if role == 'DELETE' else 'ADD')['columns']
        exact = ' AND '.join(f"(a.values_json->>'{f}')=(d.values_json->>'{f}')" for f in fields)
        # Another attempt's proved success also excludes an unchanged row from blind repetition.
        work.execute("UPDATE decisions d SET state='APPLIED',selected=false,reason='applied_in_other_attempt' "
                     "WHERE EXISTS (SELECT 1 FROM applied a WHERE a.role=? AND a.state=? AND " + exact + ')',
                     [role, 'DELETED' if role == 'DELETE' else 'APPLIED'])
        business = {'CLIENTS': ['INN'], 'DOGTAGS': ['INN', 'MAV_LABEL'],
                    'NUMBERS': ['MSISDN'], 'DELETE': ['MSISDN']}[role]
        same_key = ' AND '.join(f"(a.values_json->>'{f}')=(d.values_json->>'{f}')" for f in business)
        work.execute("UPDATE decisions d SET state='CONFLICT',selected=false,reason='current_evidence_conflict' "
                     "WHERE EXISTS (SELECT 1 FROM applied a WHERE a.role=? AND a.state='CONFLICT' AND " + same_key + ')', [role])
        for identity, reason in retry['success_reasons'].items():
            work.execute("UPDATE decisions SET selected=true,reason=? WHERE export_row_id=? AND state='APPLIED'",
                         [reason, identity])
        work.read_parquet(str(paths[role])).create_view('old_projection')
        work.execute('CREATE TABLE original_rows AS SELECT *, row_number() OVER (ORDER BY page_index) '
                     'AS export_ordinal FROM old_projection')
        if retry.get('stage_source'):
            work.execute('CREATE TABLE original_records AS SELECT MSISDN,export_ordinal AS ordinal, '
                         'export_ordinal AS page_index FROM original_rows')
        else:
            work.read_parquet(str(paths['records'])).create_view('original_records')
        keys = {'CLIENTS': [('INN', 'INN')],
                'DOGTAGS': [('INN', 'INN'), ('MAV_LABEL_NAME', 'MAV_LABEL'), ('MAV_LABEL_LATIN', 'MAV_LABEL_LATIN')],
                'NUMBERS': [(f, f) for f in file_definition('NUMBERS')['columns']],
                'DELETE': [('MSISDN', 'MSISDN')]}[role]
        join = ' AND '.join(f'old.{left}=o.{right}' for left, right in keys)
        work.execute('CREATE TABLE eligible AS SELECT DISTINCT old.page_index FROM original_records old '
                     'JOIN original_rows o ON ' + join +
                     ' JOIN decisions d ON d.export_ordinal=o.export_ordinal WHERE d.selected')
        work.execute(f'COPY (SELECT * FROM eligible ORDER BY page_index) TO '
                     f"{sql_path(directory / 'retry-eligible.parquet')} (FORMAT PARQUET)")
        work.execute('ALTER TABLE decisions ADD COLUMN source_ordinal BIGINT')
        work.execute('ALTER TABLE decisions ADD COLUMN source_record_id VARCHAR')
        work.execute('UPDATE decisions SET source_ordinal=o.page_index FROM original_rows o '
                     'WHERE o.export_ordinal=decisions.export_ordinal')
        if retry.get('stage_source'):
            work.execute('UPDATE decisions SET source_ordinal=export_ordinal,source_record_id=export_row_id')
        else:
            work.execute('UPDATE decisions SET source_record_id=r.record_id FROM original_records r '
                         'WHERE r.page_index=decisions.source_ordinal')
    return directory / 'retry-eligible.parquet'


def select_retry(sessions, revision, dataset, checkpoint):
    retry, directory = revision.settings['retry'], dataset.directory
    role = retry['role']
    with connection(directory.parent / 'retry.duckdb', memory_limit=dataset.memory_limit, threads=dataset.threads,
                    temp_directory=directory / '.retry-spill') as work:
        work.read_parquet(str(directory / 'records.parquet')).create_view('corrected_records')
        work.execute('CREATE TABLE selected_records AS SELECT r.* FROM corrected_records r JOIN eligible e USING(page_index)')
        problems = []
        unknown_reasons = [key for key in retry['success_reasons'] if not work.execute(
            "SELECT count(*) FROM decisions WHERE state='APPLIED' AND export_row_id=?", [key]).fetchone()[0]]
        if unknown_reasons:
            problems.append({'code': 'retry_success_reason_not_applied'})
        # Corrections must affect selected rows, including all source rows collapsed into a dependency.
        added = revision.correction_overlay
        with sessions() as db:
            original = db.get(ProcessingRevision, UUID(retry['source_revision_id']))
            new_changes = retry.get('stage_corrections', []) if retry.get('stage_source') else added[len(original.correction_overlay):]
        for change in new_changes:
            applied_edit = role != 'DELETE' and work.execute("""SELECT count(*) FROM corrected_records r
                JOIN original_records o USING(page_index) WHERE r.ordinal=? AND EXISTS (SELECT 1 FROM applied a
                WHERE a.role='NUMBERS' AND a.state IN ('APPLIED','CONFLICT')
                AND ((a.values_json->>'MSISDN')=o.MSISDN OR (a.values_json->>'MSISDN')=r.MSISDN))""",
                [change['ordinal']]).fetchone()[0]
            if applied_edit:
                problems.append({'code': 'retry_requires_change', 'ordinal': change['ordinal'],
                    'message': 'Исправление затрагивает применённый номер; нужна явная CHANGE или сверка.'})
            elif not work.execute('SELECT count(*) FROM selected_records WHERE ordinal=?', [change['ordinal']]).fetchone()[0]:
                problems.append({'code': 'retry_correction_not_selected', 'ordinal': change['ordinal']})
        definitions = output_spec(dataset_operation(dataset))['roles']
        for item in definitions:
            table = dataset.roles[item]
            work.read_parquet(str(directory / f'{table}.parquet')).create_view(f'full_{table}')
        if role == 'DELETE':
            wanted = {'DELETE': 'SELECT DISTINCT p.* FROM full_deletions p JOIN selected_records s USING(MSISDN)'}
        else:
            wanted = {'CLIENTS': 'SELECT DISTINCT p.* FROM full_clients p JOIN selected_records s USING(INN)'}
            if role in ('DOGTAGS', 'NUMBERS'):
                wanted['DOGTAGS'] = ('SELECT DISTINCT p.* FROM full_dogtags p JOIN selected_records s '
                                      'ON p.INN=s.INN AND p.MAV_LABEL=s.MAV_LABEL_NAME AND p.MAV_LABEL_LATIN=s.MAV_LABEL_LATIN')
            if role == 'NUMBERS':
                wanted['NUMBERS'] = 'SELECT DISTINCT p.* FROM full_numbers p JOIN selected_records s USING(INN,MSISDN)'
        counts = {}
        for item in definitions:
            table = dataset.roles[item]
            query = wanted.get(item, f'SELECT * FROM full_{table} WHERE false')
            fields = file_definition(item, 'DELETE' if item == 'DELETE' else 'ADD')['columns']
            work.execute(f'CREATE TABLE wanted_{table} AS {query}')
            if item != role and item in wanted:
                keys = ['INN'] if item == 'CLIENTS' else ['INN', 'MAV_LABEL']
                match = ' AND '.join(f"(u.values_json->>'{f}')=p.{f}" for f in keys)
                uncertain = work.execute(f'SELECT count(*) FROM wanted_{table} p WHERE EXISTS '
                    '(SELECT 1 FROM unresolved u WHERE u.role=? AND ' + match + ')', [item]).fetchone()[0]
                if uncertain:
                    problems.append({'code': 'retry_dependency_reconciliation', 'role': item, 'count': uncertain})
            # Primary rows were authorized by the selected attempt. Dependencies need their exact current version.
            exclude = '' if item == role else (' WHERE NOT EXISTS (SELECT 1 FROM applied a WHERE a.role=? '
                "AND a.state='APPLIED' AND " + ' AND '.join(f"(a.values_json->>'{f}')=p.{f}" for f in fields) + ')')
            work.execute(f'CREATE TABLE selected_{table} AS SELECT p.* FROM wanted_{table} p' + exclude,
                         [] if item == role else [item])
            counts[item] = work.execute(f'SELECT count(*) FROM selected_{table}').fetchone()[0]
            path = directory / f'{table}.parquet'
            # The full canonical verification already ran; the retry verifier independently checks closure.
            path.rename(directory / f'full_{table}.parquet')
            work.execute(f'COPY (SELECT * FROM selected_{table} ORDER BY page_index) TO {sql_path(path)} (FORMAT PARQUET)')
        counts = {k: v for k, v in counts.items() if v}
        if not counts:
            problems.append({'code': 'retry_no_eligible_rows'})
        # Persist exact coverage and excluded identities without STATUS/service columns in any output file.
        for table in ('decisions', 'applied', 'selected_records', 'original_rows', 'original_records'):
            work.execute('COPY (SELECT *' + (', row_number() OVER () AS page_index' if table == 'applied' else '') + f' FROM {table}) TO {sql_path(directory / f"retry_{table}.parquet")} (FORMAT PARQUET)')
        for item in definitions:
            table = dataset.roles[item]
            work.execute(f'COPY (SELECT * FROM wanted_{table}) TO {sql_path(directory / f"retry_wanted_{table}.parquet")} (FORMAT PARQUET)')
    (directory.parent / 'retry.duckdb').unlink()
    base_version = dataset.summary['dataset_version']
    dataset.summary.update(retry=retry, retry_base_version=base_version, dataset_version=RETRY_VERSION + ('-delete' if role == 'DELETE' else ''),
        output_spec=retry_spec(dataset_operation(dataset), list(counts)) if counts else None,
        counts=counts, retry_diagnostics=problems, blocking=dataset.summary['blocking'] or bool(problems))
    from app.domain.reconciliation import reconcile_retry
    with connection(memory_limit=dataset.memory_limit, threads=dataset.threads) as work:
        checked = reconcile_retry(work, directory, dataset.summary)
    dataset.summary['reconciliation'] = checked
    dataset.summary['blocking'] |= not checked['complete']
    return dataset


def retry_roles(version):
    from app.domain.canonical import ROLES
    from app.domain.delete import DELETE_ROLES
    base = DELETE_ROLES if version.endswith('-delete') else ROLES
    return {**base, **{f'retry_{name}': f'retry_{name}' for name in ('decisions', 'applied', 'selected_records', 'original_rows', 'original_records')},
            **{f'retry_wanted_{role}': f'retry_wanted_{name}' for role, name in base.items() if role.isupper()},
            **{f'retry_full_{role}': f'full_{name}' for role, name in base.items() if role.isupper()}}


class StageDeleteSource:
    """Immutable indexed DELETE stage, whose rows are independent of CHANGE replacement input."""
    def __init__(self, sessions, retry):
        self.sessions, self.artifact_id = sessions, UUID(retry['artifact_id'])
        self.mapping_digest = canonical_digest({'artifact_id': retry['artifact_id']})
        self.summary = {'columns': ['MSISDN'], 'schema_supported': True, 'file_errors': [],
                        'records_count': 0, 'parsed_records': 0, 'unknown_remainder': False}

    def records(self):
        from app.domain.ingress import SourceRecord
        with self.sessions() as db:
            for row in db.scalars(select(ExportRow).where(ExportRow.artifact_id == self.artifact_id)
                                  .order_by(ExportRow.ordinal).execution_options(yield_per=500)):
                self.summary['records_count'] += 1
                self.summary['parsed_records'] += 1
                yield SourceRecord(str(row.id), row.ordinal, row.ordinal + 1, row.ordinal + 1,
                                   [row.values['MSISDN']], row.values, [], {'MSISDN': 0})
