"""Operation-aware output contracts through real intake, worker, approval and download."""
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from app.models import Artifact

from test_automatic_intake import drive, receive, seed
from processing_helpers import runtime


def test_delete_only_msisdn_deduplicates_and_preserves_raw_lineage(backend, tmp_path):
    seed(backend)
    client = backend.client()
    receipt = receive(client, data=b'MSISDN\r\n001900\r\n001900\r\n002900\r\n').json()['result']
    intake_id = receipt['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    revision = state['revision']['id']
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{revision}"
    result = client.get(base + '/artifacts').json()
    assert [obj['role'] for obj in result['artifacts']] == ['DELETE', 'ZIP']
    assert result['manifest']['counts'] == {'DELETE': 2}
    assert result['manifest']['reconciliation']['complete'] is True
    records = client.get(base + '/records').json()['items']
    assert [row['disposition'] for row in records] == ['included', 'exact_duplicate', 'included']
    assert records[1]['representative_id'] == records[0]['record_id']
    assert records[0]['effective'] == {'MSISDN': '001900'}
    artifact = result['artifacts'][0]
    page = client.get(base + f"/artifacts/{artifact['id']}/preview?limit=1").json()
    assert page['columns'] == ['MSISDN'] and page['items'] == [['001900']]
    assert page['next_cursor'] == 1
    assert client.get(base + f"/artifacts/{artifact['id']}/preview?after=1").json()['items'] == [['002900']]
    approved = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={'operation_id': str(uuid4()),
        'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']})
    assert approved.status_code == 200, approved.text
    downloaded = client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']})
    assert downloaded.content == b'MSISDN\r\n001900\r\n002900\r\n'

    saved = client.post(f"/api/cases/{state['intake']['case_id']}/revisions", json={
        'operation_id': str(uuid4()), 'expected_revision_id': revision,
        'source_asset_id': state['revision']['source']['id'], 'corrections': [{
            'record_id': records[2]['record_id'], 'ordinal': 3, 'field': 'MSISDN',
            'before': '002900', 'after': '003900'}], 'overrides': []})
    assert saved.status_code == 200, saved.text
    new_revision = saved.json()['result']['revision']
    assert new_revision['settings']['operation'] == 'DELETE'
    assert new_revision['filename_components']['operation'] == 'DELETE'
    assert client.get(base + '/approval').json()['approved'] is False
    assert client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']}).status_code == 409


@pytest.mark.parametrize('role', ['DELETE', 'ZIP'])
def test_corruption_blocks_approval_and_download(backend, tmp_path, role):
    seed(backend)
    client = backend.client()
    receipt = receive(client, data=b'MSISDN\r\n001900\r\n').json()['result']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, receipt['intake']['id'])
        drive(backend, settings, receipt['intake']['id'])
    state = client.get(f"/api/intakes/{receipt['intake']['id']}").json()
    revision, case = state['revision']['id'], state['intake']['case_id']
    base = f'/api/cases/{case}/revisions/{revision}'
    result = client.get(base + '/artifacts').json()
    artifact = next(obj for obj in result['artifacts'] if obj['role'] == role)
    with backend.app.state.sessions() as db:
        obj = db.scalar(select(Artifact).where(Artifact.id == UUID(artifact['id'])))
        backend.app.state.storage.path_for_key(obj.storage_key).write_bytes(b'corrupted')
    approval = client.post(f'/api/cases/{case}/approval', json={'operation_id': str(uuid4()),
        'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']})
    assert approval.status_code == 503
    assert client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']}).status_code == 503


def test_automatic_add_keeps_three_exact_contracts_with_indexed_preview(backend, tmp_path):
    seed(backend)
    client = backend.client()
    receipt = receive(client).json()['result']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, receipt['intake']['id'])
        drive(backend, settings, receipt['intake']['id'])
    state = client.get(f"/api/intakes/{receipt['intake']['id']}").json()
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    result = client.get(base + '/artifacts').json()
    assert result['output_spec']['roles'] == ['CLIENTS', 'DOGTAGS', 'NUMBERS']
    assert result['output_spec']['stages'] == [{'id': 'ADD', 'roles': ['CLIENTS', 'DOGTAGS', 'NUMBERS'], 'depends_on': []}]
    assert result['manifest']['version'] == 'operation-artifact-manifest-v2'
    assert set(result['manifest']['previews']) == {'CLIENTS', 'DOGTAGS', 'NUMBERS'}
    artifact = result['artifacts'][2]
    page = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
    assert page['columns'] == ['INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME']
    assert page['items'] == [['7707083893', 'Тест', '79000000000', '0', '1', '0', 'hubRTK']]


def test_mixed_source_accounts_for_every_duplicate_and_conflict_before_release(backend, tmp_path):
    """AE8: one actual intake contains valid assignments, an exact repeat and both conflicts."""
    seed(backend)
    client = backend.client()
    rows = [
        '7707083893;79000000000;Тест;Test;0;0',
        '7707083893;79000000000;Тест;Test;0;0',
        '7707083893;79000000001;Тест;Test;1;1',
        '1234567894;79000000002;Тест;Test;0;1',
        '1234567894;79000000003;Другое;Other;0;1',
        '123456789047;79000000004;Тест;Test;0;1',
        '123456789047;79000000004;Тест;Test;1;1',
    ]
    data = ('\ufeffINN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
            + '\n'.join(rows) + '\n').encode()
    receipt = receive(client, data=data)
    assert receipt.status_code == 200, receipt.text
    intake_id = receipt.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        case, revision = state['intake']['case_id'], state['revision']['id']
        base = f'/api/cases/{case}/revisions/{revision}'
        assert state['job']['state'] == 'PREPARED', state
        original = client.get(base + '/records').json()['items']
        assert [r['ordinal'] for r in original] == list(range(1, 8))
        assert [r['raw_cells'] for r in original] == [row.split(';') for row in rows]
        assert [r['disposition'] for r in original] == [
            'excluded_error', 'excluded_error', 'included', 'included', 'included', 'included', 'included']
        summary = client.get(base + '/review').json()['summary']
        assert summary['reconciliation']['complete'] is True
        assert summary['reconciliation']['unaccounted_records'] == 0
        assert summary['issue_counts'] == {'assignment_key_conflict': 2, 'flags_both_zero': 2}
        assert all(issue['scope'] == 'warning' for row in original[5:] for issue in row['issues'])
        partial = client.get(base + '/artifacts').json()
        assert partial['available']
        assert partial['manifest']['counts'] == {'CLIENTS': 3, 'DOGTAGS': 4, 'NUMBERS': 5, 'ERRORS': 2}
        report = next(obj for obj in partial['artifacts'] if obj['role'] == 'ERRORS')
        diagnostic = client.get(base + f"/artifacts/{report['id']}/preview").json()
        source_row_column = diagnostic['columns'].index('SOURCE_ROW')
        assert [row[source_row_column] for row in diagnostic['items']] == ['1', '2']
        assert partial['manifest']['reconciliation']['complete']
        assert client.post(f'/api/cases/{case}/approval', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revision,
            'manifest_hash': 'a' * 64}).status_code == 409

        corrections = [{'record_id': original[ordinal - 1]['record_id'], 'ordinal': ordinal,
                        'field': field, 'before': before, 'after': after, 'reason': 'Synthetic source reconciliation'}
                       for ordinal, field, before, after in [
                           (1, 'IS_KSS', '0', '1'), (2, 'IS_KSS', '0', '1'),
                           (5, 'MAV_LABEL_NAME', 'Другое', 'Тест'),
                           (5, 'MAV_LABEL_LATIN', 'Other', 'Test'), (7, 'IS_MAV', '1', '0')]]
        saved = client.post(f'/api/cases/{case}/processing/save-and-start', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revision,
            'source_asset_id': state['revision']['source']['id'], 'corrections': corrections, 'overrides': []})
        assert saved.status_code == 200, saved.text
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current
    newer = f"/api/cases/{case}/revisions/{current['revision']['id']}"
    result = client.get(newer + '/artifacts').json()
    assert result['manifest']['counts'] == {'CLIENTS': 3, 'DOGTAGS': 3, 'NUMBERS': 5}
    assert result['manifest']['reconciliation']['complete'] is True
    assert client.get(newer + '/review').json()['summary']['dispositions'] == {'included': 5, 'exact_duplicate': 2}
    corrected = client.get(newer + '/records').json()['items']
    assert [r['record_id'] for r in corrected] == [r['record_id'] for r in original]
    assert [r['raw_cells'] for r in corrected] == [r['raw_cells'] for r in original]
    assert corrected[6]['representative_id'] == corrected[5]['record_id']
    assert client.get(base + '/records').json()['items'] == original
    artifact = next(item for item in result['artifacts'] if item['role'] == 'NUMBERS')
    page = client.get(newer + f"/artifacts/{artifact['id']}/preview").json()
    assert [row[2] for row in page['items']] == [f'7900000000{i}' for i in range(5)]
    assert [row[3:5] for row in page['items'][:2]] == [['0', '1'], ['1', '1']]
