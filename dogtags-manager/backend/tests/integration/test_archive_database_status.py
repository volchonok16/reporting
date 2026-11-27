"""Archive status is a durable owner-scoped operator mark, separate from preparation."""
from uuid import uuid4

from test_archive_deletion import prepared


def test_archive_and_file_status_persist_independently_with_replay_and_conflict(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path)
    path = f'/api/intakes/{intake_id}/database-status'
    body = {'operation_id': str(uuid4()), 'expected_status': 'IN_PROGRESS', 'status': 'LOADED'}
    assert backend.client('other').post(path, json=body).status_code == 404
    assert client.post(path, json=body, headers={'X-CSRF-Token': 'invalid'}).status_code == 403
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    assert client.post(path, json=body).json()['id'] == response.json()['id']
    value = client.get(f'/api/intakes/{intake_id}').json()
    assert value['intake']['database_status'] == 'LOADED'
    assert value['intake']['worked_at'] == state['intake']['worked_at']
    assert client.get('/api/intakes').json()['items'][0]['intake']['database_status'] == 'LOADED'
    stale = {**body, 'operation_id': str(uuid4()), 'status': 'IN_PROGRESS'}
    assert client.post(path, json=stale).status_code == 409
    file = next(file for file in value['output_files'] if file['role'] == 'CLIENTS')
    assert file['database_status'] == 'IN_PROGRESS'
    changed = client.post(path, json={**body, 'operation_id': str(uuid4()), 'artifact_id': file['id']})
    assert changed.status_code == 200, changed.text
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    artifacts = client.get(base + '/artifacts').json()['artifacts']
    assert next(file for file in artifacts if file['role'] == 'CLIENTS')['database_status'] == 'LOADED'
    assert next(file for file in artifacts if file['role'] == 'NUMBERS')['database_status'] == 'IN_PROGRESS'
    assert client.post(path, json={**body, 'operation_id': str(uuid4()), 'artifact_id': str(uuid4())}).status_code == 404
    assert client.post(path, json={**body, 'operation_id': str(uuid4()), 'status': 'BAD'}).status_code == 422
