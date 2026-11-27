"""Real prepared bytes, explicit external events, and causal registry projection."""
from uuid import uuid4

import pytest

from processing_helpers import runtime
from test_automatic_intake import DATA, seed
from test_change_stages import approval, prepared


def backfill(client, **options):
    result = client.post('/api/registry/backfill', json={'batch_size': 100, **options})
    assert result.status_code == 200, result.text
    return result.json()


def drain(client):
    for _ in range(100):
        if backfill(client)['complete']:
            return
    raise AssertionError('Backfill did not complete')


def attempt(client, bundle, role='NUMBERS', predecessors=None, ordered=True):
    if ordered and role in ('DOGTAGS', 'NUMBERS'):
        previous_role = 'CLIENTS' if role == 'DOGTAGS' else 'DOGTAGS'
        previous = attempt(client, bundle, previous_role, predecessors)
        evidence(client, previous)
        predecessors = [previous['id']]
    artifact = next(a for a in bundle['artifacts'] if a['role'] == role)
    body = {'operation_id': str(uuid4()), 'artifact_id': artifact['id'],
            'artifact_set_id': bundle['artifact_set_id'], 'manifest_hash': bundle['manifest_hash'],
            'predecessor_ids': predecessors or [], 'reason': 'Operator submitted this exact CSV'}
    response = client.post('/api/external-attempts', json=body)
    assert response.status_code == 200, response.text
    assert client.post('/api/external-attempts', json=body).json() == response.json()
    return response.json()


def evidence(client, submission, outcome='APPLIED', **options):
    body = {'operation_id': str(uuid4()), 'outcome': outcome, 'coverage': 'FILE',
            'reason': 'External operator confirmation 42', **options}
    response = client.post(f"/api/external-attempts/{submission['id']}/evidence", json=body)
    assert response.status_code == 200, response.text
    assert client.post(f"/api/external-attempts/{submission['id']}/evidence", json=body).json() == response.json()
    return response.json()


def assignments(client):
    response = client.get('/api/registry', params={'kind': 'ASSIGNMENT'})
    assert response.status_code == 200, response.text
    return response.json()


def test_preparation_download_and_manual_evidence_are_distinct(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, base, bundle = prepared(client, backend, settings, DATA)
        approval(client, state['intake']['case_id'], state['revision']['id'], bundle)
        artifact = bundle['artifacts'][2]
        assert client.get(base + f"/artifacts/{artifact['id']}/download", params={
            'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']}).status_code == 200
    drain(client)
    assert assignments(client)['items'][0]['external_state'] == 'UNKNOWN'
    submission = attempt(client, bundle)
    event = evidence(client, submission)
    assert event['author_id'] and event['reason'] == 'External operator confirmation 42'
    assert event['artifact_id'] == artifact['id'] and event['covered_rows'] == 1
    row = assignments(client)['items'][0]
    assert row['external_state'] == 'APPLIED' and row['prepared_count'] == 1
    events = client.get(f"/api/external-attempts/{submission['id']}/evidence").json()['items']
    assert len(events) == 1
    snapshot = assignments(client)['snapshot_version']
    assert client.post('/api/registry/rebuild', json={'batch_size': 100}).status_code == 200
    assert assignments(client)['items'] == [row]
    assert assignments(client)['snapshot_version'] == snapshot


def test_partial_coverage_conflict_resolution_and_snapshot_fencing(backend, tmp_path):
    seed(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001')
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, two)
    drain(client)
    submission = attempt(client, bundle)
    artifact = bundle['artifacts'][2]['id']
    rows = client.get(f'/api/artifacts/{artifact}/export-rows').json()['items']
    partial = evidence(client, submission, 'PARTIAL', coverage='UNKNOWN')
    assert partial['covered_rows'] == 0
    assert {r['external_state'] for r in assignments(client)['items']} == {'UNKNOWN'}
    yes = evidence(client, submission, coverage='ROWS', export_row_ids=[rows[0]['id']])
    state = assignments(client)
    assert {r['external_state'] for r in state['items']} == {'UNKNOWN', 'APPLIED'}
    no = evidence(client, submission, 'REJECTED', coverage='ROWS', export_row_ids=[rows[0]['id']])
    conflict = next(r for r in assignments(client)['items'] if r['external_state'] == 'CONFLICT')
    body = {'operation_id': str(uuid4()), 'entry_id': conflict['id'], 'evidence_ids': [yes['id'], no['id']],
            'chosen_event_id': yes['id'], 'reason': 'External audit confirmed this row was applied',
            'expected_snapshot_version': state['snapshot_version']}
    assert client.post('/api/registry/resolutions', json=body).status_code == 409
    body['expected_snapshot_version'] = assignments(client)['snapshot_version']
    response = client.post('/api/registry/resolutions', json=body)
    assert response.status_code == 200, response.text
    assert client.post('/api/registry/resolutions', json=body).json() == response.json()
    assert {r['external_state'] for r in assignments(client)['items']} == {'UNKNOWN', 'APPLIED'}
    # A new contradiction stays visible; the previous resolution does not silence it.
    evidence(client, submission, 'REJECTED', coverage='ROWS', export_row_ids=[rows[0]['id']])
    assert 'CONFLICT' in {r['external_state'] for r in assignments(client)['items']}


@pytest.mark.parametrize('delivery', [('DELETE', 'ADD'), ('ADD', 'DELETE')])
def test_causal_delete_survives_late_add_evidence_and_delivery_order(backend, tmp_path, delivery):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, added = prepared(client, backend, settings, DATA)
        _, _, deleted = prepared(client, backend, settings, b'MSISDN\r\n79000000000\r\n')
    drain(client)
    add = attempt(client, added)
    delete = attempt(client, deleted, 'DELETE', [add['id']])
    for operation in delivery:
        evidence(client, delete if operation == 'DELETE' else add)
    assert assignments(client)['items'][0]['external_state'] == 'DELETED'
    # A later explicit operator confirmation of the earlier ADD cannot revive the number.
    # Real correlated RETURN evidence is covered through DISCOVER in test_return_evidence.
    evidence(client, add)
    assert assignments(client)['items'][0]['external_state'] == 'DELETED'
    before = assignments(client)['items']
    client.post('/api/registry/rebuild', json={'batch_size': 100})
    assert assignments(client)['items'] == before


def test_unordered_add_delete_is_conflict_and_requires_explicit_resolution(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, added = prepared(client, backend, settings, DATA)
        _, _, deleted = prepared(client, backend, settings, b'MSISDN\r\n79000000000\r\n')
    drain(client)
    yes = evidence(client, attempt(client, added))
    no = evidence(client, attempt(client, deleted, 'DELETE'))
    state = assignments(client)
    entry = state['items'][0]
    assert entry['external_state'] == 'CONFLICT'
    result = client.post('/api/registry/resolutions', json={'operation_id': str(uuid4()),
        'entry_id': entry['id'], 'evidence_ids': [yes['id'], no['id']], 'chosen_event_id': no['id'],
        'reason': 'Reconciled against external database: number absent',
        'expected_snapshot_version': state['snapshot_version']})
    assert result.status_code == 200, result.text
    assert assignments(client)['items'][0]['external_state'] == 'DELETED'


def test_change_out_of_order_evidence_is_saved_as_conflict(backend, tmp_path):
    from test_change_stages import change
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        state, _, _ = prepared(client, backend, settings, DATA)
        revision = change(client, state, old)
        from test_automatic_intake import drive
        drive(backend, settings, state['intake']['id'])
        bundle = client.get(f"/api/cases/{state['intake']['case_id']}/revisions/{revision}/artifacts").json()
    drain(client)
    deletion = attempt(client, bundle, 'DELETE')
    addition = attempt(client, bundle, predecessors=[deletion['id']])
    event = evidence(client, addition)
    assert event['outcome'] == 'APPLIED'
    assert 'CONFLICT' in {r['external_state'] for r in assignments(client)['items']}
    evidence(client, deletion)
    assert 'CONFLICT' not in {r['external_state'] for r in assignments(client)['items']}


def test_numbers_without_causal_clients_dogtags_is_recorded_as_conflict(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
    drain(client)
    submission = attempt(client, bundle, ordered=False)
    evidence(client, submission)
    assert assignments(client)['items'][0]['external_state'] == 'CONFLICT'
    # Coverage is exact and remains independently queryable for STATUS/retry correlation.
    rows = client.get(f"/api/artifacts/{submission['artifact_id']}/export-rows").json()
    assert rows['items'][0]['evidence_state'] == 'APPLIED'
    assert rows['snapshot_version'] == assignments(client)['snapshot_version']
    history = client.get(f"/api/artifacts/{submission['artifact_id']}/external-attempts", params={'limit': 1}).json()
    assert history['items'][0]['id'] == submission['id']
    assert backend.client('other').get(f"/api/artifacts/{submission['artifact_id']}/external-attempts").status_code == 404


def test_role_dependencies_follow_relevant_rows_not_unrelated_failures(backend, tmp_path):
    seed(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001').replace(
        b'7707083893', b'1234567894')
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, two)
    drain(client)
    clients = attempt(client, bundle, 'CLIENTS', ordered=False)
    labels = attempt(client, bundle, 'DOGTAGS', [clients['id']], ordered=False)
    numbers = attempt(client, bundle, 'NUMBERS', [labels['id']], ordered=False)
    for submission in (clients, labels):
        rows = client.get(f"/api/artifacts/{submission['artifact_id']}/export-rows").json()['items']
        good = next(row for row in rows if row['values']['INN'] == '7707083893')
        bad = next(row for row in rows if row['values']['INN'] != '7707083893')
        evidence(client, submission, coverage='ROWS', export_row_ids=[good['id']])
        evidence(client, submission, 'REJECTED', coverage='ROWS', export_row_ids=[bad['id']])
    evidence(client, numbers)
    page = assignments(client)
    by_number = {}
    for entry in page['items']:
        source = client.get(f"/api/registry/{entry['id']}/sources").json()['items'][0]
        by_number[source['values']['MSISDN']] = entry['external_state']
    assert by_number == {'79000000000': 'APPLIED', '79000000001': 'CONFLICT'}
