"""Interrupted receipt publication remains durable, and obsolete discovery is fenced."""
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from app.models import Case, Intake, Operation, ProcessingRun
from test_automatic_intake import drive, receive, seed


@pytest.mark.parametrize('after_publish', [False, True])
def test_receipt_recovers_before_or_after_raw_publication(backend, tmp_path, monkeypatch, after_publish):
    from app.processing.recovery import sweep
    from processing_helpers import runtime
    seed(backend)
    storage, key, client = backend.app.state.storage, uuid4(), backend.client()
    original = storage.publish
    def interrupted(staged):
        if after_publish:
            original(staged)
        raise RuntimeError('Simulated process interruption')
    monkeypatch.setattr(storage, 'publish', interrupted)
    with pytest.raises(RuntimeError):
        receive(client, key=key)
    with backend.app.state.sessions() as db:
        receipt = db.scalar(select(Operation).where(Operation.action == 'intake.upload'))
        assert receipt.status == 'RUNNING' and receipt.private_pending
        assert not list(db.scalars(select(Case)))
    monkeypatch.setattr(storage, 'publish', original)
    with runtime(backend, tmp_path) as settings:
        sweep(backend.app.state.sessions, settings)
        result = receive(client, key=key)
        assert result.status_code == 200
        intake_id = result.json()['result']['intake']['id']
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    assert client.get(f'/api/intakes/{intake_id}').json()['job']['state'] == 'PREPARED'
    with backend.app.state.sessions() as db:
        assert len(list(db.scalars(select(Case)))) == 1


def test_old_discovery_cannot_publish_after_new_decisions(backend, tmp_path):
    from app.processing.leases import claim
    from app.processing.discovery import assess, finish_discovery
    from processing_helpers import runtime
    seed(backend)
    client = backend.client()
    initial = receive(client).json()['result']
    intake_id = initial['intake']['id']
    with runtime(backend, tmp_path) as settings:
        with backend.app.state.sessions() as db:
            intake = db.get(Intake, UUID(intake_id))
            run = db.scalar(select(ProcessingRun).where(ProcessingRun.intake_version_id == intake.current_version_id))
            run_id = run.id
        lease = claim(backend.app.state.sessions, run_id, settings)
        result = assess(backend.app.state.sessions, lease, settings, backend.app.state.storage, tmp_path / 'discovery')
        saved = client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': initial['version']['id'],
            'decisions': {'partner': 'RTK ABC', 'reason': 'Уточнение партнёра'}})
        assert saved.status_code == 200
        assert finish_discovery(backend.app.state.sessions, lease, result, settings) is False
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['revision']['profile_snapshot']['partner'] == 'RTK ABC'
    with backend.app.state.sessions() as db:
        assert db.get(ProcessingRun, run_id).state == 'SUPERSEDED'


def test_legacy_source_replacement_supersedes_discovery(backend, tmp_path):
    from app.processing.leases import claim
    from app.processing.discovery import assess, finish_discovery
    from conftest import upload
    from processing_helpers import runtime
    from test_automatic_intake import DATA
    seed(backend)
    client = backend.client()
    initial = receive(client).json()['result']
    with runtime(backend, tmp_path) as settings:
        run_id = UUID(initial['job']['id'])
        lease = claim(backend.app.state.sessions, run_id, settings)
        result = assess(backend.app.state.sessions, lease, settings, backend.app.state.storage, tmp_path / 'discovery')
        replacement = upload(client, initial['intake']['case_id'], data=DATA.removeprefix(b'\xef\xbb\xbf'))
        assert replacement.status_code == 200
        assert finish_discovery(backend.app.state.sessions, lease, result, settings) is False
    restored = client.get(f"/api/intakes/{initial['intake']['id']}").json()
    assert restored['revision']['source']['id'] == replacement.json()['result']['source']['id']
    assert restored['source']['id'] == initial['source']['id']
    assert client.get('/api/intakes').json()['items'] == [restored]
    with backend.app.state.sessions() as db:
        case = db.get(Case, UUID(initial['intake']['case_id']))
        assert str(case.head_revision_id) == replacement.json()['result']['revision']['id']
        assert db.get(ProcessingRun, run_id).state == 'SUPERSEDED'


def test_concurrent_duplicate_upload_has_one_receipt_and_case(backend, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import time
    from sqlalchemy import event
    seed(backend)
    key = uuid4()
    fsync = backend.app.state.storage._fsync_directory
    def delayed_fsync(directory):
        time.sleep(0.1)
        return fsync(directory)
    monkeypatch.setattr(backend.app.state.storage, '_fsync_directory', delayed_fsync)
    def bounded_sql(connection, _record, _proxy):
        with connection.cursor() as cursor:
            cursor.execute('SET statement_timeout=2000')
    event.listen(backend.engine, 'checkout', bounded_sql)
    try:
        # Context keeps both HTTP requests on one ASGI loop, as in one API process.
        with backend.client() as client, ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(receive, client, key=key) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
    finally:
        event.remove(backend.engine, 'checkout', bounded_sql)
    assert all(result.status_code == 200 for result in results), [r.text for r in results]
    assert results[0].json()['id'] == results[1].json()['id']
    assert results[0].json()['result'] == results[1].json()['result']
    with backend.app.state.sessions() as db:
        assert len(list(db.scalars(select(Case)))) == 1
        assert len(list(db.scalars(select(ProcessingRun)))) == 1


def test_staging_fsync_error_is_classified_before_receipt(backend, monkeypatch):
    seed(backend)
    client = backend.client()
    def fail(directory):
        raise OSError('Synthetic fsync failure')
    monkeypatch.setattr(backend.app.state.storage, '_fsync_directory', fail)
    response = receive(client)
    assert response.status_code == 503 and response.json()['error']['code'] == 'storage_unavailable'
    with backend.app.state.sessions() as db:
        assert not list(db.scalars(select(Operation).where(Operation.action == 'intake.upload')))


def test_discovery_completion_rolls_back_graph_and_recovers_expired_lease(backend, tmp_path, monkeypatch):
    from datetime import timedelta
    from app.models import IntakeAssessment, ProcessingRevision, utcnow
    from app.processing import discovery
    from app.processing.leases import claim
    from app.processing.recovery import sweep
    from processing_helpers import runtime
    seed(backend)
    client = backend.client()
    initial = receive(client).json()['result']
    job_id = UUID(initial['job']['id'])
    from dataclasses import replace
    with runtime(backend, tmp_path) as settings:
        settings = replace(settings, retry_backoff_seconds=0.000001)
        lease = claim(backend.app.state.sessions, job_id, settings)
        assessment = discovery.assess(backend.app.state.sessions, lease, settings, backend.app.state.storage,
                                     tmp_path / 'discovery')
        original = discovery.enqueue
        def interrupted(db, revision):
            original(db, revision)
            raise RuntimeError('Simulated crash before atomic completion commit')
        monkeypatch.setattr(discovery, 'enqueue', interrupted)
        with pytest.raises(RuntimeError):
            discovery.finish_discovery(backend.app.state.sessions, lease, assessment, settings)
        with backend.app.state.sessions() as db:
            assert not list(db.scalars(select(IntakeAssessment)))
            assert not list(db.scalars(select(ProcessingRevision)))
            run = db.get(ProcessingRun, job_id)
            run.lease_expires_at = utcnow() - timedelta(seconds=1)
            db.commit()
        assert discovery.finish_discovery(backend.app.state.sessions, lease, assessment, settings) is False
        monkeypatch.setattr(discovery, 'enqueue', original)
        sweep(backend.app.state.sessions, settings)
        drive(backend, settings, initial['intake']['id'])
        drive(backend, settings, initial['intake']['id'])
    restored = client.get(f"/api/intakes/{initial['intake']['id']}").json()
    assert restored['job']['state'] == 'PREPARED', restored


def test_decisions_invalidate_approved_old_head_before_discovery(backend, tmp_path):
    from app.models import Approval
    from processing_helpers import runtime
    from test_approval_races import approval_body
    from test_download_scope import download_url, params
    seed(backend)
    client = backend.client()
    initial = receive(client).json()['result']
    intake_id = initial['intake']['id']
    case_id = initial['intake']['case_id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        revision_id = state['revision']['id']
        artifacts = client.get(f'/api/cases/{case_id}/revisions/{revision_id}/artifacts').json()
        manifest_hash = artifacts['manifest_hash']
        body = approval_body(revision_id, manifest_hash)
        approved = client.post(f'/api/cases/{case_id}/approval', json=body)
        assert approved.status_code == 200
        changed = client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'partner': 'RTK ABC', 'reason': 'Уточнение партнёра'}})
        assert changed.status_code == 200
        assert client.get(f'/api/cases/{case_id}').json()['head_revision_id'] is None
        old = client.get(f'/api/cases/{case_id}/revisions/{revision_id}/approval').json()
        assert not old['current'] and not old['approved']
        assert client.post(f'/api/cases/{case_id}/approval', json={**body, 'operation_id': str(uuid4())}).status_code == 409
        assert client.get(download_url(case_id, revision_id, artifacts['artifacts'][0]['id']),
                          params=params(revision_id, manifest_hash)).status_code == 409
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    newer = client.get(f'/api/intakes/{intake_id}').json()['revision']
    assert newer['sequence'] == 2 and newer['parent_revision_id'] == revision_id
    with backend.app.state.sessions() as db:
        assert len(list(db.scalars(select(Approval)))) == 1
