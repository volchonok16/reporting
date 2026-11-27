"""Archive deletion is owner scoped, permanent, fenced and idempotent."""
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text

from app.auth.accounts import create_account
from app.models import AuditEvent, Intake, Operation
from processing_helpers import runtime
from test_automatic_intake import DATA, drive, receive, seed
from test_intake_migration import downgrade


def prepared(backend, tmp_path, *, data=DATA):
    seed(backend)
    client = backend.client()
    intake_id = receive(client, data=data).json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    detail = client.get(f'/api/intakes/{intake_id}').json()
    assert detail['job']['state'] == 'PREPARED'
    return client, intake_id, detail


def command(state, deleted=True, key=None):
    return {'operation_id': str(key or uuid4()), 'expected_version_id': state['version']['id'],
            'expected_deleted_at': state['intake']['deleted_at'], 'deleted': deleted}


def test_deleted_file_is_permanent_and_old_links_are_blocked(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path)
    case, revision = state['intake']['case_id'], state['revision']['id']
    base = f'/api/cases/{case}/revisions/{revision}'
    deletion = command(state)
    path = f'/api/intakes/{intake_id}/archive'
    response = client.post(path, json=deletion)
    assert response.status_code == 200, response.text
    deleted = response.json()['result']
    assert deleted['intake']['deleted_at']
    assert client.get('/api/intakes').json()['items'] == []
    assert client.get('/api/intakes?deleted=true').json()['items'] == []
    assert client.get(f'/api/intakes/{intake_id}').status_code == 409
    assert client.get(base + '/artifacts').status_code == 409
    assert client.get(f"/api/cases/{case}/sources/{state['source']['id']}/raw").status_code == 409
    assert client.post(path, json=command(deleted, False)).status_code == 409
    assert client.post(path, json=deletion).json()['id'] == response.json()['id']
    assert client.post(f'/api/intakes/{intake_id}/decisions', json={'operation_id': str(uuid4()),
        'expected_version_id': state['version']['id'], 'decisions': {}}).status_code == 409
    with backend.app.state.sessions() as db:
        events = list(db.scalars(select(AuditEvent).where(AuditEvent.action.in_(('intake.deleted', 'intake.restored')))))
        assert [event.action for event in events] == ['intake.deleted']


def test_archive_mutation_requires_owner_permission_csrf_and_finished_job(backend):
    seed(backend)
    client = backend.client()
    state = receive(client).json()['result']
    path = f"/api/intakes/{state['intake']['id']}/archive"
    body = command(state)
    assert backend.client('other').post(path, json=body).status_code == 404
    with backend.app.state.sessions() as db:
        create_account(db, 'reader', 'Synthetic test password 42', permissions=('case.read',))
        db.commit()
    assert backend.client('reader').post(path, json=body).status_code == 403
    assert client.post(path, json=body, headers={'X-CSRF-Token': 'invalid'}).status_code == 403
    response = client.post(path, json=body)
    assert response.status_code == 409 and response.json()['error']['code'] == 'archive_processing_active'
    assert client.get(path.removesuffix('/archive')).json()['intake']['deleted_at'] is None


def test_concurrent_duplicate_delete_and_stale_restore_are_safe(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path)
    second = backend.client()
    body = command(state)
    path = f'/api/intakes/{intake_id}/archive'
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda c: c.post(path, json=body), (client, second)))
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json()['id'] == responses[1].json()['id']
    deleted = responses[0].json()['result']
    assert client.post(path, json=command(deleted, False)).status_code == 409
    assert client.post(path, json={**body, 'deleted': False}).status_code == 409
    with backend.app.state.sessions() as db:
        assert len(list(db.scalars(select(Operation).where(Operation.client_operation_id == UUID(body['operation_id']))))) == 1
        assert db.get(Intake, UUID(intake_id)).deleted_at is not None


def test_archive_migration_preserves_files_and_refuses_to_lose_deleted_state(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path)
    path = f'/api/intakes/{intake_id}/archive'
    assert client.post(path, json=command(state)).status_code == 200
    with backend.engine.connect() as db:
        version_before = db.scalar(text('SELECT version_num FROM alembic_version'))
    with pytest.raises(RuntimeError, match='Restore deleted'), backend.engine.begin() as db:
        downgrade(db, '0007')
    with backend.engine.connect() as db:
        assert db.scalar(text('SELECT version_num FROM alembic_version')) == version_before
