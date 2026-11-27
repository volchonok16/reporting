"""Ownership, mixed-own identities, durable bounded backfill and immutable evidence."""
from uuid import UUID, uuid4

from processing_helpers import runtime
from test_automatic_intake import DATA, seed
from test_change_stages import prepared
from test_external_evidence import assignments, attempt, backfill, drain, evidence


def test_registry_attempt_evidence_and_export_rows_are_owner_scoped(backend, tmp_path):
    seed(backend)
    client, other = backend.client(), backend.client('other')
    with runtime(backend, tmp_path) as settings:
        _, _, one = prepared(client, backend, settings, DATA)
        _, _, two = prepared(client, backend, settings, DATA)
    drain(client)
    submission = attempt(client, one)
    event = evidence(client, submission)
    entry = assignments(client)['items'][0]
    assert assignments(other)['items'] == []
    for path in (f"/api/external-attempts/{submission['id']}",
                 f"/api/external-attempts/{submission['id']}/evidence",
                 f"/api/artifacts/{one['artifacts'][2]['id']}/export-rows",
                 f"/api/registry/{entry['id']}/sources", f"/api/registry/{entry['id']}/evidence"):
        assert other.get(path).status_code == 404
    assert other.post(f"/api/external-attempts/{submission['id']}/evidence", json={
        'operation_id': str(uuid4()), 'outcome': 'APPLIED', 'coverage': 'FILE', 'reason': 'unauthorized'}).status_code == 404
    wrong_row = client.get(f"/api/artifacts/{two['artifacts'][2]['id']}/export-rows").json()['items'][0]['id']
    assert client.post(f"/api/external-attempts/{submission['id']}/evidence", json={
        'operation_id': str(uuid4()), 'outcome': 'APPLIED', 'coverage': 'ROWS',
        'export_row_ids': [wrong_row], 'reason': 'mixed-own-file'}).status_code == 404
    body = {'operation_id': str(uuid4()), 'artifact_id': one['artifacts'][2]['id'],
            'artifact_set_id': two['artifact_set_id'], 'manifest_hash': two['manifest_hash'], 'reason': 'mixed-own-set'}
    assert client.post('/api/external-attempts', json=body).status_code == 409
    assert other.post('/api/registry/backfill', json={'artifact_id': one['artifacts'][2]['id']}).status_code == 404
    # Persisted evidence and its coverage are immutable even through direct SQL.
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError
    with backend.engine.connect() as connection:
        for table, column, value in [('evidence_events', 'id', event['id']),
                                      ('external_attempts', 'id', submission['id']),
                                      ('evidence_coverage', 'event_id', event['id'])]:
            with pytest.raises(DBAPIError):
                connection.execute(text(f'DELETE FROM {table} WHERE {column}=:id'), {'id': UUID(value)})
            connection.rollback()


def test_interrupted_backfill_keeps_new_evidence_and_exact_rows(backend, tmp_path):
    seed(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001')
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, two)
    artifact = bundle['artifacts'][2]['id']
    first = backfill(client, batch_size=1, artifact_id=artifact)
    assert first['cursor'] == 1 and not first['artifact_complete'] and not first['complete']
    state = assignments(client)
    assert state['complete'] is False and state['items'][0]['prepared_count'] == 0
    submission = attempt(client, bundle)
    event = evidence(client, submission)
    # Simulate a fresh API connection/process resuming its persisted cursor.
    client = backend.client()
    second = backfill(client, batch_size=1, artifact_id=artifact)
    assert second['cursor'] == 2 and second['artifact_complete']
    # Reopening a completed file must stop the UI loop even when other files
    # still need indexing; a no-op does not advance the evidence snapshot.
    repeated = backfill(client, batch_size=1, artifact_id=artifact)
    assert repeated == second
    drain(client)
    rows = assignments(client)['items']
    assert len(rows) == 2 and {r['external_state'] for r in rows} == {'APPLIED'}
    assert {r['prepared_count'] for r in rows} == {1}
    events = client.get(f"/api/external-attempts/{submission['id']}/evidence").json()['items']
    assert len(events) == 1 and events[0]['id'] == event['id'] and events[0]['covered_rows'] == 2
    export = client.get(f'/api/artifacts/{artifact}/export-rows', params={'limit': 1}).json()
    assert export['next_cursor'] == 1 and len(export['items']) == 1
    next_page = client.get(f'/api/artifacts/{artifact}/export-rows', params={'after': 1}).json()
    assert next_page['items'][0]['ordinal'] == 2
    assert client.post('/api/registry/rebuild', json={'batch_size': 1}).json()['next_cursor']


def test_legacy_v1_backfill_resumes_without_rewriting_bytes_or_inventing_success(backend, tmp_path):
    from test_artifact_publication import link_for_read_proof, publish, setup
    client, case_id, source_id, revision_id = setup(backend, legacy=True)
    bundle = publish(backend, source_id, revision_id, tmp_path / 'legacy')
    assert bundle.manifest['version'] == 'hub-artifact-manifest-v1'
    set_id = link_for_read_proof(backend, revision_id, bundle)
    from sqlalchemy import select
    from app.models import Artifact, ArtifactSet
    with backend.app.state.sessions() as db:
        original_manifest = db.get(ArtifactSet, set_id).manifest
        numbers = db.scalar(select(Artifact).where(Artifact.artifact_set_id == set_id, Artifact.role == 'NUMBERS'))
        artifact_id = str(numbers.id)
        original_bytes = backend.app.state.storage.path_for_key(numbers.storage_key).read_bytes()
    first = backfill(client, artifact_id=artifact_id, batch_size=1)
    assert first['cursor'] == 1 and not first['artifact_complete']
    assert {r['external_state'] for r in assignments(client)['items']} == {'UNKNOWN'}
    prepared_bundle = client.get(f'/api/cases/{case_id}/revisions/{revision_id}/artifacts').json()
    for artifact in prepared_bundle['artifacts'][:2]:
        backfill(client, artifact_id=artifact['id'])
    submission = attempt(client, prepared_bundle)
    event = evidence(client, submission)
    second = backfill(backend.client(), artifact_id=artifact_id, batch_size=1)
    assert second['cursor'] == 2 and second['artifact_complete']
    drain(client)
    assert {r['external_state'] for r in assignments(client)['items']} == {'APPLIED'}
    assert client.get(f"/api/external-evidence/{event['id']}").json()['covered_rows'] == 2
    with backend.app.state.sessions() as db:
        assert db.get(ArtifactSet, set_id).manifest == original_manifest
        assert backend.app.state.storage.path_for_key(numbers.storage_key).read_bytes() == original_bytes


def test_rebuild_recreates_deleted_projection_from_immutable_exports(backend, tmp_path):
    from sqlalchemy import delete
    from app.models import RegistryEntry
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
    drain(client)
    evidence(client, attempt(client, bundle))
    before = assignments(client)['items']
    with backend.app.state.sessions() as db:
        db.execute(delete(RegistryEntry))
        db.commit()
    assert assignments(client)['items'] == []
    cursor = None
    for _ in range(10):
        result = client.post('/api/registry/rebuild', json={'batch_size': 1, 'after': cursor}).json()
        cursor = result['next_cursor']
        if result['complete']:
            break
    assert assignments(client)['items'] == before


def test_composite_database_constraints_reject_mixed_owned_artifacts(backend, tmp_path):
    import pytest
    from sqlalchemy import select, text
    from sqlalchemy.exc import DBAPIError
    from app.models import EvidenceEvent, ExternalAttempt, ExportRow, StageArtifact
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, one = prepared(client, backend, settings, DATA)
        _, _, two = prepared(client, backend, settings, DATA)
    drain(client)
    first = attempt(client, one)
    event = evidence(client, first)
    with backend.app.state.sessions() as db:
        original = db.get(ExternalAttempt, UUID(first['id']))
        wrong = UUID(two['artifacts'][2]['id'])
        wrong_stage = db.scalar(select(StageArtifact).where(StageArtifact.artifact_id == wrong))
        wrong_row = db.scalar(select(ExportRow).where(ExportRow.artifact_id == wrong))
        with pytest.raises(DBAPIError):
            db.execute(text('''INSERT INTO evidence_coverage (owner_id,artifact_id,event_id,export_row_id)
                VALUES (:owner,:artifact,:event,:row)'''), {'owner': original.owner_id,
                'artifact': original.artifact_id, 'event': UUID(event['id']), 'row': wrong_row.id})
        db.rollback()
        bad_attempt = ExternalAttempt(owner_id=original.owner_id, case_id=original.case_id,
            artifact_set_id=original.artifact_set_id, artifact_id=wrong, stage_id=wrong_stage.stage_id,
            manifest_hash=original.manifest_hash, reason='Invalid cross-bundle test',
            operation_id=uuid4(), request_digest='a' * 64)
        db.add(bad_attempt)
        with pytest.raises(DBAPIError):
            db.flush()
        db.rollback()
        other_attempt = attempt(client, two)
        bad_event = EvidenceEvent(owner_id=original.owner_id, artifact_id=original.artifact_id,
            attempt_id=UUID(other_attempt['id']), author_id=original.owner_id, reason='Invalid mixed attempt',
            origin='MANUAL', outcome='APPLIED', coverage='FILE', operation_id=uuid4(),
            request_digest='b' * 64, snapshot_version=1)
        db.add(bad_event)
        with pytest.raises(DBAPIError):
            db.flush()
        db.rollback()


def test_historical_artifact_still_accepts_explicit_evidence(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, bundle = prepared(client, backend, settings, DATA)
    drain(client)
    changed = client.post(f"/api/cases/{state['intake']['case_id']}/revisions", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['revision']['source']['id']})
    assert changed.status_code == 200, changed.text
    submission = attempt(client, bundle)
    evidence(client, submission)
    assert assignments(client)['items'][0]['external_state'] == 'APPLIED'
