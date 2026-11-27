from uuid import UUID, uuid4

from app.models import ProcessingRevision
from processing_helpers import SOURCE, runtime
from test_archive_deletion import prepared
from test_automatic_intake import drive


def command(state, row, excluded=True, before=False):
    return {'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
            'source_asset_id': state['source']['id'], 'row_selections': [
                {'record_id': row['record_id'], 'ordinal': row['ordinal'], 'before': before, 'excluded': excluded}]}


def test_selection_recompute_restore_replay_and_partner_change_preserve_source(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path, data=SOURCE)
    case = state['intake']['case_id']
    base = f"/api/cases/{case}/revisions/{state['revision']['id']}"
    rows = client.get(base + '/records').json()['items']
    source_url = f"/api/cases/{case}/sources/{state['source']['id']}/raw"
    original = client.get(source_url).content
    body = command(state, rows[0])
    path = f'/api/cases/{case}/processing/save-and-start'
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    assert client.post(path, json=body).json()['id'] == response.json()['id']
    with runtime(backend, tmp_path / 'selection') as settings:
        drive(backend, settings, intake_id)
    selected = client.get(f'/api/intakes/{intake_id}').json()
    assert selected['job']['state'] == 'PREPARED'
    assert selected['job']['summary']['counts']['NUMBERS'] == len(rows) - 1
    current = f"/api/cases/{case}/revisions/{selected['revision']['id']}"
    assert client.get(current + '/records').json()['items'][0]['disposition'] == 'excluded_manual'
    entry = selected['revision']['settings']['row_selections'][rows[0]['record_id']]
    assert entry['author_id'] and entry['created_at'] and entry['mapping_digest']
    assert client.get(source_url).content == original
    assert client.get(base + '/records').json()['items'][0]['disposition'] == 'included'
    # Changing only partner preserves selection and provenance for the same source mapping.
    changed = client.post(f'/api/intakes/{intake_id}/decisions', json={'operation_id': str(uuid4()),
        'expected_version_id': selected['version']['id'], 'decisions': {'partner': 'RTK ABC', 'reason': 'Synthetic partner correction'}})
    assert changed.status_code == 200, changed.text
    with runtime(backend, tmp_path / 'partner') as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    selected = client.get(f'/api/intakes/{intake_id}').json()
    assert selected['revision']['settings']['row_selections'][rows[0]['record_id']] == entry
    assert selected['job']['summary']['counts']['NUMBERS'] == len(rows) - 1
    assert client.post(path, json=command(selected, rows[0], False, False)).status_code == 409
    restored = client.post(path, json=command(selected, rows[0], False, True))
    assert restored.status_code == 200, restored.text
    with runtime(backend, tmp_path / 'restore') as settings:
        drive(backend, settings, intake_id)
    restored = client.get(f'/api/intakes/{intake_id}').json()
    assert restored['job']['summary']['counts']['NUMBERS'] == len(rows)
    assert client.post(path, json=body).json()['id'] == response.json()['id']
    assert client.get(f'/api/intakes/{intake_id}').json()['revision']['id'] == restored['revision']['id']
    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(restored['revision']['id']))
        assert len(revision.settings['row_selection_history']) == 2


def test_excluding_every_source_row_does_not_fabricate_empty_imports(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path)
    case = state['intake']['case_id']
    row = client.get(f"/api/cases/{case}/revisions/{state['revision']['id']}/records").json()['items'][0]
    saved = client.post(f'/api/cases/{case}/processing/save-and-start', json=command(state, row))
    assert saved.status_code == 200, saved.text
    with runtime(backend, tmp_path / 'all-excluded') as settings:
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'BLOCKED'
    assert current['job']['summary']['counts'] == {}
    assert current['job']['summary']['reconciliation']['complete']
    assert current['job']['summary']['dispositions'] == {'excluded_manual': 1}
    assert current['output_files'] == []


def test_selection_requires_owner_valid_identity_and_exact_before_value(backend, tmp_path):
    client, _, state = prepared(backend, tmp_path)
    case = state['intake']['case_id']
    row = client.get(f"/api/cases/{case}/revisions/{state['revision']['id']}/records").json()['items'][0]
    path, body = f'/api/cases/{case}/revisions', command(state, row)
    assert backend.client('other').post(path, json=body).status_code == 404
    forged = command(state, {**row, 'record_id': str(uuid4())})
    assert client.post(path, json=forged).status_code == 404
    assert client.post(path, json=command(state, row, True, True)).status_code == 409
    assert client.post(path, json={**body, 'row_selections': [{**body['row_selections'][0], 'excluded': 'yes'}]}).status_code == 422
    assert client.get(f'/api/cases/{case}').json()['head_revision_id'] == state['revision']['id']
