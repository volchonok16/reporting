"""Explicit immutable old-number scope, independent of the replacement snapshot."""
import csv
from copy import deepcopy
from uuid import UUID, uuid4

import pyarrow as pa
import pyarrow.parquet as pq
from sqlalchemy import select

from app.auth.policy import owned_case, scoped_object
from app.domain.canonical import ROLES, connection, sql_path, write_rows
from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.operations import canonical_digest
from app.domain.output_spec import file_definition
from app.errors import ApiError
from app.models import Artifact, ArtifactSet, ChangeScope, OutputStage, StageArtifact
from app.storage.local import StorageFailure

CHANGE_VERSION = 'change-canonical-v1'
CHANGE_ROLES = {**ROLES, 'DELETE': 'deletions', 'delete_scope': 'delete_scope'}
SCOPE_SCHEMA = pa.schema([('MSISDN', pa.string()), ('page_index', pa.int64())])


def select_scope(db, user, selection, storage):
    """A historical prepared artifact is valid even after its source head changes."""
    from app.storage.artifact_sets import verify_artifact_set
    artifact = scoped_object(db, user, Artifact, UUID(str(selection['artifact_id'])))
    artifact_set = db.get(ArtifactSet, artifact.artifact_set_id)
    if artifact.role not in ('DELETE', 'NUMBERS'):
        raise ApiError(422, 'delete_scope_role_invalid', 'Выберите подготовленный DELETE или NUMBERS со старыми номерами.')
    if selection['manifest_hash'] != artifact_set.manifest_hash:
        raise ApiError(409, 'delete_scope_manifest_conflict', 'Подтвердите точную версию комплекта со старыми номерами.')
    try:
        verified = verify_artifact_set(db, artifact_set, storage)
    except StorageFailure:
        raise ApiError(503, 'delete_scope_integrity_error', 'Комплект старых номеров повреждён или недоступен.') from None
    obj = next(item for item in verified.artifacts if item.role == artifact.role)
    if not obj.row_count:
        raise ApiError(422, 'delete_scope_empty', 'Подтвердите непустой список старых номеров.')
    return {'artifact_id': str(artifact.id), 'artifact_set_id': str(artifact_set.id),
            'case_id': str(artifact_set.case_id), 'revision_id': str(artifact_set.revision_id),
            'manifest_hash': artifact_set.manifest_hash, 'role': artifact.role,
            'sha256': artifact.sha256, 'size_bytes': artifact.size_bytes,
            'row_count': obj.row_count, 'confirmed_by': str(user.id), 'confirmed': True}


def link_scope(db, revision):
    selected = revision.settings.get('delete_scope')
    if revision.settings.get('operation') != 'CHANGE':
        return
    if not selected:
        raise ValueError('CHANGE requires an explicitly confirmed delete scope.')
    db.add(ChangeScope(case_id=revision.case_id, revision_id=revision.id,
        owner_id=UUID(selected['confirmed_by']), source_case_id=UUID(selected['case_id']),
        source_artifact_set_id=UUID(selected['artifact_set_id']), source_artifact_id=UUID(selected['artifact_id']),
        snapshot=deepcopy(selected), digest=canonical_digest(selected)))
    db.flush()


def verify_scope_link(db, revision):
    scope = db.scalar(select(ChangeScope).where(ChangeScope.revision_id == revision.id))
    if (not scope or scope.snapshot != revision.settings.get('delete_scope')
            or scope.digest != canonical_digest(scope.snapshot)):
        raise StorageFailure()
    artifact = db.get(Artifact, scope.source_artifact_id)
    source_set = db.get(ArtifactSet, scope.source_artifact_set_id)
    expected = {'artifact_id': str(artifact.id), 'artifact_set_id': str(source_set.id),
                'case_id': str(source_set.case_id), 'revision_id': str(source_set.revision_id),
                'manifest_hash': source_set.manifest_hash, 'role': artifact.role,
                'sha256': artifact.sha256, 'size_bytes': artifact.size_bytes,
                'row_count': source_set.manifest['counts'].get(artifact.role),
                'confirmed_by': str(scope.owner_id), 'confirmed': True}
    if (scope.snapshot != expected or artifact.role not in ('DELETE', 'NUMBERS')
            or not expected['row_count']):
        raise StorageFailure()
    return scope


def add_delete_projection(dataset, selected, storage):
    """Stream a pinned source CSV; deduplicate on disk without holding a number set in RAM."""
    path = storage.verify(storage.key_for_hash(selected['sha256']), selected['sha256'], selected['size_bytes'])
    ensure_csv_field_capacity(selected['size_bytes'])
    header = file_definition(selected['role'], 'DELETE' if selected['role'] == 'DELETE' else 'ADD')['columns']
    directory = dataset.directory
    count, pending = 0, []
    with path.open('r', encoding='cp1251', newline='') as stream, pq.ParquetWriter(
            directory / 'delete_scope.parquet', SCOPE_SCHEMA) as writer:
        reader = csv.reader(stream, delimiter=';', strict=True)
        if next(reader, None) != header:
            raise StorageFailure()
        for count, row in enumerate(reader, 1):
            if len(row) != len(header) or not row[header.index('MSISDN')]:
                raise StorageFailure()
            pending.append({'MSISDN': row[header.index('MSISDN')], 'page_index': count})
            if len(pending) >= 1000:
                write_rows(writer, pending, SCOPE_SCHEMA)
                pending = []
        write_rows(writer, pending, SCOPE_SCHEMA)
    if count != selected['row_count']:
        raise StorageFailure()
    with connection(directory / 'scope.duckdb', memory_limit=dataset.memory_limit, threads=dataset.threads,
                    temp_directory=directory / '.scope-spill') as db:
        db.read_parquet(str(directory / 'delete_scope.parquet')).create_view('old_numbers')
        db.execute(f'COPY (SELECT MSISDN,min(page_index) AS page_index FROM old_numbers '
                   f'GROUP BY MSISDN ORDER BY page_index) TO {sql_path(directory / "deletions.parquet")} (FORMAT PARQUET)')
        count = pq.read_metadata(directory / 'deletions.parquet').num_rows
    (directory / 'scope.duckdb').unlink()
    from app.domain.reconciliation import reconcile_change
    with connection(memory_limit=dataset.memory_limit, threads=dataset.threads,
                    temp_directory=directory / '.scope-reconciliation-spill') as db:
        reconciliation = reconcile_change(db, directory)
    dataset.summary = {**dataset.summary, 'reconciliation': reconciliation,
                       'blocking': dataset.summary['blocking'] or not reconciliation['complete'], 'dataset_version': CHANGE_VERSION, 'operation': 'CHANGE',
                       'delete_scope': selected, 'counts': {'DELETE': count, **dataset.summary['counts']}}
    return dataset


def link_stages(db, artifact_set, revision, artifacts):
    """Stable stage IDs and composite links are available to future external attempts."""
    from app.domain.output_spec import revision_spec
    spec = revision_spec(revision)
    if spec['operation'] != 'CHANGE':
        return
    stages = {}
    for definition in spec['stages']:
        stage = OutputStage(id=uuid4(), case_id=revision.case_id, revision_id=revision.id,
            artifact_set_id=artifact_set.id, name=definition['id'],
            depends_on_id=stages[definition['depends_on'][0]].id if definition['depends_on'] else None)
        db.add(stage)
        db.flush()
        stages[stage.name] = stage
        for artifact in artifacts:
            if artifact.role in definition['roles']:
                db.add(StageArtifact(artifact_set_id=artifact_set.id, stage_id=stage.id, artifact_id=artifact.id))
    db.flush()


def change_view(db, user, case_id, revision):
    owned_case(db, user, case_id)
    scope = verify_scope_link(db, revision)
    stages = list(db.scalars(select(OutputStage).where(OutputStage.revision_id == revision.id)
                            .order_by(OutputStage.depends_on_id.is_not(None))))
    return {'revision_id': revision.id, 'delete_scope': scope.snapshot,
            'stages': [{'id': stage.id, 'name': stage.name, 'artifact_set_id': stage.artifact_set_id,
                        'depends_on_id': stage.depends_on_id, 'artifact_ids': list(db.scalars(
                            select(StageArtifact.artifact_id).where(StageArtifact.stage_id == stage.id)))}
                       for stage in stages]}


def verify_stage_links(db, artifact_set):
    from app.models import ProcessingRevision
    revision = db.get(ProcessingRevision, artifact_set.revision_id)
    scope = verify_scope_link(db, revision)
    if artifact_set.manifest.get('delete_scope') != scope.snapshot:
        raise StorageFailure()
    stages = list(db.scalars(select(OutputStage).where(OutputStage.artifact_set_id == artifact_set.id)))
    by_name = {stage.name: stage for stage in stages}
    if (len(stages) != 2 or set(by_name) != {'DELETE', 'ADD'}
            or by_name['DELETE'].depends_on_id is not None
            or by_name['ADD'].depends_on_id != by_name['DELETE'].id
            or any(stage.revision_id != revision.id or stage.case_id != revision.case_id for stage in stages)):
        raise StorageFailure()
    links = list(db.execute(select(StageArtifact, Artifact).join(Artifact, StageArtifact.artifact_id == Artifact.id)
                           .where(StageArtifact.artifact_set_id == artifact_set.id)))
    expected = {'DELETE': by_name['DELETE'].id, **{role: by_name['ADD'].id for role in ('CLIENTS', 'DOGTAGS', 'NUMBERS')}}
    if len(links) != 4 or {obj.role: link.stage_id for link, obj in links} != expected:
        raise StorageFailure()
