"""Real PostgreSQL migration of frozen v1 records, plus scoped v2 intake persistence."""
import hashlib
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, Table, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.auth.policy import scoped_object
from app.db import make_engine, make_session_factory
from app.errors import ApiError
from app.models import Case, ProcessingRun, SourceAsset, User, utcnow


def migrate(connection, revision):
    configuration = Config(str(Path(__file__).resolve().parents[2] / 'alembic.ini'))
    configuration.attributes['connection'] = connection
    command.upgrade(configuration, revision)


def downgrade(connection, revision):
    configuration = Config(str(Path(__file__).resolve().parents[2] / 'alembic.ini'))
    configuration.attributes['connection'] = connection
    command.downgrade(configuration, revision)


def test_gpbm_migration_preserves_previous_rules_and_custom_partner_settings(backend):
    from app.admin.publish_rules import active_snapshot, published_profile
    from app.domain.rules import seed_config, rules_snapshot, profile_for
    from app.models import RulePublication, SourceProfileVersion
    with backend.engine.begin() as connection:
        downgrade(connection, '0010')
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = [*user.permissions, 'rules.publish']
        config = seed_config()
        config['version'] = 'legacy-before-gpbm'
        del config['profiles']['ГПБМ']
        config['profiles']['RTK HUB']['INTERNAL_OPERATOR_NAME'] = 'customHub'
        snapshot = rules_snapshot(config)
        previous = RulePublication(version=snapshot['version'], digest=snapshot['digest'],
            snapshot=snapshot, created_by=user.id, reason='Frozen legacy migration fixture')
        db.add(previous)
        for partner in config['profiles']:
            db.add(SourceProfileVersion(version=f"rules:{snapshot['digest']}:{partner}",
                config_hash=snapshot['digest'], snapshot=profile_for(snapshot, partner)))
        db.flush()
        old_snapshot, old_id = previous.snapshot, previous.id
        db.commit()
    with backend.engine.begin() as connection:
        migrate(connection, 'head')
    with backend.app.state.sessions() as db:
        snapshot = active_snapshot(db)
        assert db.get(RulePublication, old_id).snapshot == old_snapshot
        assert snapshot['config']['profiles']['RTK HUB']['INTERNAL_OPERATOR_NAME'] == 'customHub'
        assert snapshot['config']['profiles']['ГПБМ'] == {'SPREADING': '1', 'INTERNAL_OPERATOR_NAME': ''}
        assert published_profile(db, snapshot, 'ГПБМ').snapshot['SPREADING'] == '1'
    with pytest.raises(RuntimeError, match='GPBM publication is immutable'), backend.engine.begin() as connection:
        downgrade(connection, '0010')


def test_external_stage_constraint_round_trip(backend):
    constraint = text("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                      "WHERE conrelid='output_stages'::regclass "
                      "AND conname='ck_output_stages_change_stage_order'")
    with backend.engine.begin() as db:
        downgrade(db, '0004')
        migrate(db, '0005')
        expected = db.scalar(constraint)
        migrate(db, '0006')
        downgrade(db, '0005')
        assert db.scalar(constraint) == expected
        migrate(db, 'head')


def test_external_stage_downgrade_refuses_standalone_add(backend, tmp_path):
    from uuid import UUID
    from app.domain.registry import stages_for_bundle
    from app.models import ArtifactSet
    from processing_helpers import runtime
    from test_automatic_intake import DATA, seed
    from test_change_stages import prepared
    seed(backend)
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(backend.client(), backend, settings, DATA)
    with backend.app.state.sessions() as db:
        stages_for_bundle(db, db.get(ArtifactSet, UUID(bundle['artifact_set_id'])))
        db.commit()
    with backend.engine.connect() as db:
        before = db.scalar(text('SELECT version_num FROM alembic_version'))
    with pytest.raises(RuntimeError, match='Standalone ADD'), backend.engine.begin() as db:
        downgrade(db, '0005')
    with backend.engine.connect() as db:
        assert db.scalar(text('SELECT version_num FROM alembic_version')) == before
        assert db.scalar(text("SELECT count(*) FROM output_stages WHERE name='ADD' AND depends_on_id IS NULL")) == 1


def test_upgrade_preserves_v1_corrections_approval_and_file_bytes(backend, tmp_path):
    """Seed the frozen 0001 SQL schema, never the mutable application model definitions."""
    schema = 'test_' + uuid4().hex
    with backend.engine.begin() as db:
        db.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = make_engine(backend.settings.database_url, connect_args={'options': f'-c search_path={schema}'})
    try:
        with engine.begin() as db:
            migrate(db, '0001')
            metadata = MetaData()
            tables = {name: Table(name, metadata, autoload_with=db) for name in (
                'users', 'cases', 'source_assets', 'processing_revisions', 'processing_runs',
                'operations', 'artifact_sets', 'artifacts', 'approvals')}
            ids = {name: uuid4() for name in tables}
            now = utcnow()
            raw = b'INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n1234567894;001900;Test;Test;1;1\r\n'
            output = b'INN\r\n1234567894\r\n'
            source_hash, output_hash = (hashlib.sha256(value).hexdigest() for value in (raw, output))
            files = {source_hash: raw, output_hash: output}
            for key, value in files.items():
                (tmp_path / key).write_bytes(value)
            def insert(name, **values):
                db.execute(tables[name].insert().values(id=ids[name], created_at=now, **values))
            insert('users', username='frozen-synthetic-operator', password_hash='not-a-login',
                   permissions=['case.read'], active=True)
            insert('cases', owner_id=ids['users'], title='Frozen v1', external_state='NOT_SUBMITTED')
            insert('source_assets', case_id=ids['cases'], created_by=ids['users'], filename='synthetic.csv',
                   encoding='utf-8', sha256=source_hash, size_bytes=len(raw), storage_key=source_hash,
                   inspection={'contract_version': 'hub-v1', 'columns': ['INN'], 'records_count': 1})
            insert('processing_revisions', case_id=ids['cases'], source_asset_id=ids['source_assets'],
                   sequence=1, created_by=ids['users'], profile_version_id='11111111-1111-4111-8111-111111111111',
                   profile_snapshot={'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
                   settings={}, correction_overlay=[{'record_id': str(uuid4()), 'ordinal': 1, 'field': 'MSISDN',
                       'before': '900', 'after': '001900', 'reason': 'Synthetic confirmed correction'}],
                   config_hash='a' * 64, rules_version='hub-rules-v1', serializer_version='cp1251-crlf-v1',
                   export_timestamp=now, export_timezone='Europe/Moscow', filename_components={'profile': 'HUB'})
            db.execute(tables['cases'].update().values(head_revision_id=ids['processing_revisions']))
            insert('processing_runs', case_id=ids['cases'], revision_id=ids['processing_revisions'],
                   work_identity='b' * 64, state='PREPARED', attempt=1, generation=1, progress={}, summary={})
            insert('operations', owner_id=ids['users'], case_id=ids['cases'], action='package.approve',
                   client_operation_id=uuid4(), request_digest='c' * 64, status='SUCCEEDED',
                   result={'approval_id': str(ids['approvals'])}, completed_at=now)
            insert('artifact_sets', case_id=ids['cases'], revision_id=ids['processing_revisions'],
                   run_id=ids['processing_runs'], generation=1, manifest={'version': 'v1', 'sha256': output_hash},
                   manifest_hash='d' * 64, reconciliation={'complete': True})
            insert('artifacts', artifact_set_id=ids['artifact_sets'], role='CLIENTS', download_filename='CLIENTS.csv',
                   storage_key=output_hash, sha256=output_hash, size_bytes=len(output))
            insert('approvals', case_id=ids['cases'], revision_id=ids['processing_revisions'],
                   artifact_set_id=ids['artifact_sets'], operation_id=ids['operations'],
                   author_id=ids['users'], manifest_hash='d' * 64)
            before = {name: list(db.execute(select(table)).mappings()) for name, table in tables.items()}
        # A failed transactional upgrade has not opened v2 writes: the complete
        # frozen schema and history remain usable by the saved v1 image.
        with pytest.raises(DBAPIError), engine.begin() as db:
            migrate(db, 'head')
            db.execute(text('SELECT 1 / 0'))
        with engine.connect() as db:
            assert db.scalar(text('SELECT version_num FROM alembic_version')) == '0001'
            for name, table in tables.items():
                assert list(db.execute(select(table)).mappings()) == before[name]
        with engine.begin() as db:
            migrate(db, 'head')
            for name, table in tables.items():
                assert list(db.execute(select(table)).mappings()) == before[name]
            assert db.scalar(text('SELECT encoding FROM source_assets')) == 'utf-8'
        for key, value in files.items():
            assert (tmp_path / key).read_bytes() == value
            assert hashlib.sha256((tmp_path / key).read_bytes()).hexdigest() == key
        for table in ('source_assets', 'processing_revisions', 'approvals', 'artifacts', 'artifact_sets'):
            with pytest.raises(DBAPIError, match='immutable record'), engine.begin() as db:
                db.execute(text(f'UPDATE {table} SET id = id'))
    finally:
        engine.dispose()
        with backend.engine.begin() as db:
            db.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))


def intake_fixture(backend):
    from app.models import Intake, IntakeVersion, IntakeAssessment
    with backend.app.state.sessions() as db:
        owner = db.scalar(select(User).where(User.username == 'operator'))
        case = Case(owner_id=owner.id, title='Unknown workbook')
        db.add(case)
        db.flush()
        source = SourceAsset(case_id=case.id, created_by=owner.id, filename='synthetic.xlsx',
                             metadata_version=2, encoding=None, sha256='e' * 64,
                             size_bytes=12, storage_key='synthetic-immutable', inspection={})
        db.add(source)
        db.flush()
        intake = Intake(case_id=case.id, source_asset_id=source.id)
        db.add(intake)
        db.flush()
        version = IntakeVersion(case_id=case.id, intake_id=intake.id, source_asset_id=source.id,
                                sequence=1, created_by=owner.id, decisions={})
        db.add(version)
        db.flush()
        assessment = IntakeAssessment(case_id=case.id, intake_id=intake.id, source_asset_id=source.id,
                                      intake_version_id=version.id, result={'format': 'xlsx'},
                                      questions=[{'code': 'partner_required'}])
        db.add(assessment)
        db.flush()
        intake.current_version_id, intake.current_assessment_id = version.id, assessment.id
        intake.state = 'NEEDS_DECISION'
        db.commit()
        return owner.id, case.id, source.id, intake.id, version.id, assessment.id


def test_unknown_source_and_decisions_survive_fresh_session_without_revision(backend):
    from app.models import Intake, IntakeVersion, IntakeAssessment, ProcessingRevision
    owner_id, case_id, source_id, intake_id, version_id, assessment_id = intake_fixture(backend)
    # New session factory models API process reopening; no in-memory identity map is reused.
    with make_session_factory(backend.engine)() as db:
        source = db.get(SourceAsset, source_id)
        assert source.encoding is None and source.metadata_version == 2 and source.inspection == {}
        assert db.get(Case, case_id).head_revision_id is None
        assert db.scalar(select(ProcessingRevision).where(ProcessingRevision.case_id == case_id)) is None
        owner = db.get(User, owner_id)
        for model, identifier in ((Intake, intake_id), (IntakeVersion, version_id), (IntakeAssessment, assessment_id)):
            assert scoped_object(db, owner, model, identifier, case_id=case_id).id == identifier
            other = db.scalar(select(User).where(User.username == 'other'))
            with pytest.raises(ApiError) as denied:
                scoped_object(db, other, model, identifier)
            assert denied.value.status == 404
        version = IntakeVersion(case_id=case_id, intake_id=intake_id, source_asset_id=source_id,
                                sequence=2, parent_version_id=version_id, created_by=owner_id,
                                decisions={'partner': 'RTK HUB'})
        db.add(version)
        db.flush()
        newer = IntakeAssessment(case_id=case_id, intake_id=intake_id, source_asset_id=source_id,
                                 intake_version_id=version.id, reader_version='xlsx-v1',
                                 result={'format': 'xlsx', 'table_id': 'Sheet1'}, questions=[])
        db.add(newer)
        db.commit()
        assert db.get(IntakeVersion, version_id).decisions == {}
        assert db.get(IntakeAssessment, assessment_id).questions == [{'code': 'partner_required'}]
        assert source.encoding is None and source.inspection == {}
    for table in ('intake_versions', 'intake_assessments'):
        for action in (f'UPDATE {table} SET id = id', f'DELETE FROM {table}'):
            with pytest.raises(DBAPIError, match='immutable record'), backend.engine.begin() as db:
                db.execute(text(action))


@pytest.mark.parametrize('kind,target', [('BUILD', 'none'), ('DISCOVER', 'none'), ('UNKNOWN', 'intake'),
                                       ('BUILD', 'intake')])
def test_run_requires_exactly_one_target_of_its_kind(backend, kind, target):
    _, case_id, _, _, version_id, _ = intake_fixture(backend)
    with backend.app.state.sessions() as db, pytest.raises(IntegrityError):
        db.add(ProcessingRun(case_id=case_id, kind=kind, revision_id=None,
                             intake_version_id=version_id if target == 'intake' else None,
                             work_identity=uuid4().hex))
        db.commit()


def test_foreign_intake_target_and_stale_assessment_head_are_rejected(backend):
    from app.models import Intake, IntakeVersion
    owner_id, case_id, source_id, intake_id, version_id, assessment_id = intake_fixture(backend)
    with backend.app.state.sessions() as db:
        other = db.scalar(select(User).where(User.username == 'other'))
        foreign = Case(owner_id=other.id, title='Foreign case')
        db.add(foreign)
        db.commit()
        with pytest.raises(IntegrityError):
            db.add(ProcessingRun(case_id=foreign.id, kind='DISCOVER', intake_version_id=version_id,
                                 work_identity=uuid4().hex))
            db.commit()
        db.rollback()
        version = IntakeVersion(case_id=case_id, intake_id=intake_id, source_asset_id=source_id,
                                sequence=2, created_by=owner_id, decisions={'partner': 'RTK HUB'})
        db.add(version)
        db.commit()
        intake = db.get(Intake, intake_id)
        intake.current_version_id = version.id
        with pytest.raises(IntegrityError):
            db.commit()


def test_discover_claim_uses_intake_target(backend):
    from app.processing.leases import claim
    _, case_id, _, _, version_id, _ = intake_fixture(backend)
    with backend.app.state.sessions() as db:
        run = ProcessingRun(case_id=case_id, kind='DISCOVER', intake_version_id=version_id,
                            work_identity=uuid4().hex)
        db.add(run)
        db.commit()
        run_id = run.id
    assert claim(backend.app.state.sessions, run_id, backend.settings) is not None
    with backend.app.state.sessions() as db:
        run = db.get(ProcessingRun, run_id)
        assert run.state == 'PROCESSING' and run.revision_id is None
        assert run.attempt == 1 and run.lease_token is not None


def test_revision_assessment_is_bound_to_exact_source_and_run_has_one_target(backend):
    from app.models import ProcessingRevision
    owner, case, source, _, version, assessment = intake_fixture(backend)
    with backend.app.state.sessions() as db:
        other_source = SourceAsset(case_id=case, created_by=owner, filename='another.csv',
                                   metadata_version=2, encoding=None, sha256='f' * 64,
                                   size_bytes=0, storage_key='another-immutable', inspection={})
        db.add(other_source)
        db.flush()
        fields = dict(case_id=case, created_by=owner, sequence=1, assessment_id=assessment,
                      profile_version_id='11111111-1111-4111-8111-111111111111',
                      profile_snapshot={}, config_hash='a' * 64, export_timezone='Europe/Moscow',
                      filename_components={})
        with pytest.raises(IntegrityError), db.begin_nested():
            db.add(ProcessingRevision(source_asset_id=other_source.id, **fields))
            db.flush()
        revision = ProcessingRevision(source_asset_id=source, **fields)
        db.add(revision)
        db.flush()
        for kind in ('BUILD', 'DISCOVER'):
            with pytest.raises(IntegrityError), db.begin_nested():
                db.add(ProcessingRun(case_id=case, kind=kind, revision_id=revision.id,
                                     intake_version_id=version, work_identity=uuid4().hex))
                db.flush()
        # Both legal variants persist independently and refer to their exact immutable target.
        build = ProcessingRun(case_id=case, revision_id=revision.id, work_identity=uuid4().hex)
        discover = ProcessingRun(case_id=case, kind='DISCOVER', intake_version_id=version,
                                 work_identity=uuid4().hex)
        db.add_all([build, discover])
        db.commit()
        assert build.kind == 'BUILD' and build.intake_version_id is None
        assert discover.revision_id is None and discover.intake_version_id == version
