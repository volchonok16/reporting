"""Qualification fixture/oracle tests; small tests never count as load evidence."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('qualify_file_processing', ROOT / 'scripts/qualify_file_processing.py')
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


def test_fixture_counts_and_oracle_detect_equal_count_wrong_bytes(tmp_path):
    source = tmp_path / 'source.csv'
    result = qualification.generate_dataset(source, 20, unique_inns=True, duplicate_every=10)
    assert result['rows'] == 20 and result['unique_rows'] == 18 and result['duplicates'] == 2
    assert result['expected']['CLIENTS']['row_count'] == 18
    assert source.read_bytes().count(b'\r\n') == 21
    for role, expected in result['expected'].items():
        path = tmp_path / (role + '.csv')
        path.write_bytes(b''.join(qualification.expected_lines(role, 20, True, 10)))
        qualification.verify_output(path, expected)
        path.write_bytes(path.read_bytes().replace(b'100000000', b'200000000', 1))
        with pytest.raises(ValueError, match='reconciliation'):
            qualification.verify_output(path, expected)


def test_excel_limits_include_header(tmp_path):
    for extension, rows in [('xlsx', 1048576), ('xls', 65536)]:
        with pytest.raises(ValueError, match='header'):
            qualification.generate_dataset(tmp_path / ('too-large.' + extension), rows)


def test_resource_reduction_uses_concurrent_sum_not_sum_of_individual_peaks():
    result = qualification.reduce_resources([
        {'workers': {'1': 100, '2': 20}, 'scratch_bytes': 10, 'cgroup_memory_current': 200},
        {'workers': {'1': 30, '2': 90}, 'scratch_bytes': 30, 'cgroup_memory_current': 180},
    ])
    assert result['per_process_peak_rss_bytes'] == {'1': 100, '2': 90}
    assert result['aggregate_peak_rss_bytes'] == 120
    assert result['scratch_high_water_bytes'] == 30
    assert result['cgroup_peak_observed_bytes'] == 200


@pytest.mark.parametrize('extension', ['csv', 'xlsx', 'xls'])
def test_generated_formats_reconcile_through_real_processing(backend, tmp_path, extension):
    """Actual reader/canonical/publish/API verifier, never a mocked result."""
    import sys
    from dataclasses import replace
    from uuid import UUID, uuid4

    from app.processing.tasks import process_run
    from app.main import create_app
    from app.models import ProcessingRun
    from sqlalchemy import select
    from test_automatic_intake import seed
    from processing_helpers import runtime

    sys.path.insert(0, str(ROOT / 'scripts'))
    fixture = qualification.generate_dataset(tmp_path / ('source.' + extension), 20, True, 10)
    backend.settings = replace(backend.settings, max_upload_bytes=1_000_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    seed(backend)
    client = backend.client()
    with Path(fixture['path']).open('rb') as stream:
        response = client.post('/api/intakes', params={'partner': 'RTK HUB'},
            headers={'X-Operation-ID': str(uuid4())}, files={'file': ('source.' + extension, stream)})
    assert response.status_code == 200
    intake_id = response.json()['result']['intake']['id']
    case_id = UUID(response.json()['result']['intake']['case_id'])
    with runtime(backend, tmp_path) as settings:
        for _ in range(2):
            with backend.app.state.sessions() as db:
                jobs = list(db.scalars(select(ProcessingRun.id).where(
                    ProcessingRun.case_id == case_id, ProcessingRun.state == 'QUEUED')))
            assert len(jobs) == 1
            process_run(backend.app.state.sessions, jobs[0], settings)
    state = client.get('/api/intakes/' + intake_id).json()
    assert state['job']['state'] == 'PREPARED', state
    job = {'intake_id': intake_id, 'fixture': fixture, 'state': state}
    qualification.reconcile(client, job, tmp_path)
    assert job['reconciled']
    page = client.get(job['preview_path'], params={'after': 15, 'limit': 2})
    assert page.status_code == 200 and len(page.json()['items']) == 2


@pytest.mark.parametrize('checkpoint', ['during_discovery_read', 'during_build_read', 'after_bundle_publication'])
def test_automatic_restart_at_real_read_build_publish_boundaries(backend, tmp_path, checkpoint):
    import json
    import time
    from uuid import UUID

    from sqlalchemy import func, select
    from kombu import Connection
    from app.models import ArtifactSet, AuditEvent, ProcessingRun
    from app.processing.dispatcher import dispatch_batch, publish_job
    from app.processing.recovery import sweep
    from app.processing.tasks import make_celery
    from processing_helpers import kill_worker, runtime, wait_for, worker
    from test_automatic_intake import receive, seed

    seed(backend)
    fixture = qualification.generate_dataset(tmp_path / 'source.csv', 10, True, 5)
    client = backend.client()
    raw = Path(fixture['path']).read_bytes()
    result = receive(client, data=raw).json()['result']
    intake_id, case_id = result['intake']['id'], result['intake']['case_id']
    initial_version = result['version']['id']
    with runtime(backend, tmp_path) as settings:
        with worker(backend, settings, tmp_path / 'interrupted', fault=checkpoint) as process:
            def reached():
                dispatch_batch(backend.app.state.sessions, settings)
                return (tmp_path / 'interrupted/checkpoint').exists()
            wait_for(reached)
            with backend.app.state.sessions() as db:
                interrupted = db.scalar(select(ProcessingRun).where(ProcessingRun.state == 'PROCESSING'))
                interrupted_id, generation = interrupted.id, interrupted.generation
            kill_worker(process)
        time.sleep(settings.lease_seconds + 0.1)
        sweep(backend.app.state.sessions, settings)
        with worker(backend, settings, tmp_path / 'restarted'):
            def finished():
                dispatch_batch(backend.app.state.sessions, settings)
                state = client.get('/api/intakes/' + intake_id).json()
                return state if state.get('job', {}).get('state') == 'PREPARED' else None
            restored = wait_for(finished)
            completed = tmp_path / 'restarted/completed_deliveries'
            def completed_count():
                return sum(json.loads(line)['run_id'] == str(interrupted_id)
                           for line in completed.read_text().splitlines()) if completed.exists() else 0
            wait_for(lambda: completed_count() >= 1)
            before = completed_count()
            publish_job(make_celery(settings), interrupted_id)  # A stale durable delivery after success.
            wait_for(lambda: completed_count() > before)
        # Closing the sole worker releases any unacknowledged message back to
        # this isolated queue, so zero pending now also proves it was acknowledged.
        with Connection(settings.broker_url) as broker:
            assert broker.channel().queue_declare(queue=settings.processing_queue, passive=True).message_count == 0
        assert restored['version']['id'] == initial_version
        assert client.get(f"/api/cases/{case_id}/sources/{result['source']['id']}/raw").content == raw
        job = {'intake_id': intake_id, 'fixture': fixture, 'state': restored}
        qualification.reconcile(client, job, tmp_path)
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 1
            recovered = db.get(ProcessingRun, interrupted_id)
            assert recovered.generation > generation and recovered.attempt == 2
            assert db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == 'processing.completed', AuditEvent.case_id == UUID(case_id))) == 1


def test_failed_upgrade_after_v2_writes_preserves_new_sources_outputs_and_evidence(backend, tmp_path):
    """After new writes, recover forward without restoring a pre-write snapshot."""
    import hashlib
    from sqlalchemy import select, text
    from sqlalchemy.exc import DBAPIError
    from app.models import ArtifactSet
    from app.storage.artifact_sets import verify_artifact_set
    from processing_helpers import runtime
    from test_automatic_intake import DATA, seed
    from test_change_stages import approval, prepared
    from test_external_evidence import attempt, evidence
    from test_intake_migration import migrate

    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, bundle = prepared(client, backend, settings, DATA)
        approval(client, state['intake']['case_id'], state['revision']['id'], bundle)
    evidence(client, attempt(client, bundle))

    def snapshot():
        with backend.engine.connect() as connection:
            names = list(connection.execute(text(
                'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename')).scalars())
            tables = {name: sorted(connection.execute(text(
                'SELECT to_jsonb(t)::text FROM "' + name + '" t')).scalars()) for name in names}
        files = {str(p.relative_to(backend.settings.storage_root)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in backend.settings.storage_root.rglob('*') if p.is_file()}
        return tables, files

    before = snapshot()
    with pytest.raises(DBAPIError), backend.engine.begin() as connection:
        connection.execute(text('ALTER TABLE source_assets ADD COLUMN interrupted_upgrade integer'))
        connection.execute(text('SELECT 1 / 0'))
    assert snapshot() == before
    with backend.engine.begin() as connection:
        migrate(connection, 'head')
    assert snapshot() == before
    with backend.app.state.sessions() as db:
        for artifact_set in db.scalars(select(ArtifactSet)):
            verify_artifact_set(db, artifact_set, backend.app.state.storage)
