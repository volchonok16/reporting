"""Readable bounded lifecycle selectors preserve ownership and pagination."""
from processing_helpers import runtime
from test_automatic_intake import DATA, seed
from test_change_stages import prepared
from test_external_evidence import attempt, drain


def test_lifecycle_candidate_and_registry_pages(backend, tmp_path):
    seed(backend)
    client, other = backend.client(), backend.client('other')
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
    first = attempt(client, bundle, 'CLIENTS', ordered=False)
    second = attempt(client, bundle, 'NUMBERS', ordered=False)
    page = client.get('/api/external-attempts', params={'limit': 1})
    assert page.status_code == 200, page.text
    page = page.json()
    assert len(page['items']) == 1 and page['next_cursor']
    item = page['items'][0]
    assert item['filename'].endswith('.csv') and item['role'] in ('CLIENTS', 'NUMBERS')
    assert item['revision_sequence'] == 1 and item['case_id']
    following = client.get('/api/external-attempts', params={'after': page['next_cursor']}).json()
    assert {item['id'], following['items'][0]['id']} == {first['id'], second['id']}
    assert other.get('/api/external-attempts').json()['items'] == []
    assert other.get('/api/external-attempts', params={'after': item['id']}).status_code == 404
    drain(client)
    registry = client.get('/api/registry').json()
    assert all(row['display_values'] for row in registry['items'])
    assert next(row for row in registry['items'] if row['kind'] == 'ASSIGNMENT')['display_values']['MSISDN'] == '79000000000'
    assert next(row for row in registry['items'] if row['kind'] == 'CLIENT')['display_values']['INN']
    assert other.get('/api/registry').json()['items'] == []
