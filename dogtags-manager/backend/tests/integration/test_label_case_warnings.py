"""Case notices survive review and approval without excluding source rows."""
from uuid import uuid4

import pytest

from processing_helpers import runtime
from test_automatic_intake import seed, drive


@pytest.mark.parametrize('operation', ['ADD', 'REPAIR'])
def test_case_variants_are_nonblocking_and_manual_correction_rechecks_them(backend, tmp_path, operation):
    seed(backend)
    client = backend.client()
    first, second = 'OOO TsS ASTREYa: meditsina', 'OOO TSS ASTREYA: meditsina'
    if operation == 'ADD':
        content = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
            f'7805406976;001900;Тест;{first};0;1;ignore\n'
            f'7805406976;002900;Тест;{second};0;1\n'
            f'7805406976;001900;Тест;{first};0;1;different ignored cell\n'
            ';;;;;;only ignored data\n')
        counts = {'CLIENTS': 1, 'DOGTAGS': 2, 'NUMBERS': 2}
    else:
        content = ('INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE;STATUS\n'
            f'7805406976;Тест;{first};1;\n7805406976;Тест;{second};1;\n')
        counts = {'DOGTAGS': 2}
    received = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': operation},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('case-variants.csv', content.encode('utf-8-sig'))})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        assert state['job']['state'] == 'PREPARED', state
        case, revision = state['intake']['case_id'], state['revision']['id']
        base = f'/api/cases/{case}/revisions/{revision}'
        bundle = client.get(base + '/artifacts').json()
        assert bundle['manifest']['counts'] == counts
        records = client.get(base + '/records').json()['items']
        assert len(records) == (3 if operation == 'ADD' else 2)
        assert all(r['issues'] and all(i['scope'] == 'warning' for i in r['issues']) for r in records)
        assert first in records[0]['issues'][0]['message'] and second in records[0]['issues'][0]['message']
        if operation == 'ADD':
            assert records[2]['disposition'] == 'exact_duplicate'
            assert state['assessment']['result']['summary']['ignored_extra_cells'] == 3
        approved = client.post(f'/api/cases/{case}/approval', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
        assert approved.status_code == 200, approved.text
        artifact = next(a for a in bundle['artifacts'] if a['role'] == 'DOGTAGS')
        downloaded = client.get(base + f"/artifacts/{artifact['id']}/download", params={
            'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
        assert downloaded.status_code == 200, downloaded.text
        assert first in downloaded.content.decode('cp1251') and second in downloaded.content.decode('cp1251')
        saved = client.post(f'/api/cases/{case}/processing/save-and-start', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revision,
            'source_asset_id': state['source']['id'], 'corrections': [{
                'record_id': records[1]['record_id'], 'ordinal': 2, 'field': 'MAV_LABEL_LATIN',
                'before': second, 'after': first, 'reason': 'Ручное решение о регистре'}]})
        assert saved.status_code == 200, saved.text
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current
    new_base = f"/api/cases/{case}/revisions/{current['revision']['id']}"
    assert all(not row['issues'] for row in client.get(new_base + '/records').json()['items'])
    assert client.get(new_base + '/artifacts').json()['manifest']['counts']['DOGTAGS'] == 1
    assert client.get(base + '/artifacts').json()['manifest_hash'] == bundle['manifest_hash']


@pytest.mark.parametrize('operation', ['ADD', 'REPAIR'])
def test_allowed_latin_general_label_survives_review_approval_and_download(backend, tmp_path, operation):
    seed(backend)
    client = backend.client()
    label = 'Тест Brand'
    content = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
               f'7707083893;79000000000;{label};Test Brand;0;1\n') if operation == 'ADD' else (
               'INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE;STATUS\n'
               f'7707083893;{label};Test Brand;1;\n')
    response = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': operation},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('latin-label.csv', content.encode('utf-8-sig'))})
    assert response.status_code == 200
    intake_id = response.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as configuration:
        drive(backend, configuration, intake_id)
        drive(backend, configuration, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED'
    case, revision = state['intake']['case_id'], state['revision']['id']
    base = f'/api/cases/{case}/revisions/{revision}'
    record = client.get(base + '/records').json()['items'][0]
    assert record['disposition'] == 'included'
    assert [(i['code'], i['scope']) for i in record['issues']] == [('label_contains_latin', 'warning')]
    bundle = client.get(base + '/artifacts').json()
    assert not any(a['role'] == 'ERRORS' for a in bundle['artifacts'])
    approved = client.post(f'/api/cases/{case}/approval', json={
        'operation_id': str(uuid4()), 'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
    assert approved.status_code == 200
    for artifact in bundle['artifacts']:
        if artifact['role'] not in ('DOGTAGS', 'NUMBERS'):
            continue
        downloaded = client.get(base + f"/artifacts/{artifact['id']}/download", params={
            'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
        assert downloaded.status_code == 200
        assert label in downloaded.content.decode('cp1251')
