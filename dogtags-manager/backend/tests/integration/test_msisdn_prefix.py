"""Ten-digit MSISDN is separated until an operator supplies the prefixed value."""
from uuid import uuid4

import pytest

from processing_helpers import runtime
from test_automatic_intake import drive, seed


@pytest.mark.parametrize('strategy', ['row', 'bulk'])
@pytest.mark.parametrize('operation', ['ADD', 'DELETE', 'REPAIR'])
def test_ten_digit_number_is_not_exported_until_manual_confirmation(backend, tmp_path, operation, strategy):
    seed(backend)
    client = backend.client()
    if operation == 'DELETE':
        data = 'MSISDN\n9937967877\n79937967878\n'
        role = 'DELETE'
    elif operation == 'REPAIR':
        data = ('INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME;STATUS\n'
                '7707083893;Тест;9937967877;0;1;0;hubRTK;\n'
                '7707083893;Тест;79937967878;0;1;0;hubRTK;\n')
        role = 'NUMBERS'
    else:
        data = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
                '7707083893;9937967877;Тест;Test;0;1\n'
                '7707083893;79937967878;Тест;Test;0;1\n')
        role = 'NUMBERS'
    received = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': operation},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('phones.csv', data.encode('utf-8-sig'))})
    assert received.status_code == 200, received.text
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        assert state['job']['state'] == 'PREPARED', state
        case, revision = state['intake']['case_id'], state['revision']['id']
        base = f'/api/cases/{case}/revisions/{revision}'
        rows = client.get(base + '/records').json()['items']
        assert rows[0]['effective']['MSISDN'] == '9937967877'
        assert rows[0]['disposition'] == 'excluded_error'
        assert any(i['code'] == 'msisdn_country_prefix' for i in rows[0]['issues'])
        bundle = client.get(base + '/artifacts').json()
        artifact = next(a for a in bundle['artifacts'] if a['role'] == role)
        preview = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
        assert [r[preview['columns'].index('MSISDN')] for r in preview['items']] == ['79937967878']
        errors = next(a for a in bundle['artifacts'] if a['role'] == 'ERRORS')
        report = client.get(base + f"/artifacts/{errors['id']}/preview").json()
        assert '9937967877' in str(report['items']) and '79937967877' in str(report['items'])
        saved = client.post(f'/api/cases/{case}/processing/save-and-start', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revision,
            'source_asset_id': state['source']['id'], 'corrections': [{
                'record_id': rows[0]['record_id'], 'ordinal': 1, 'field': 'MSISDN',
                'before': '9937967877', 'after': '79937967877', 'reason': 'Operator accepted prefix'}] if strategy == 'row' else [],
            'prefix_msisdn': strategy == 'bulk'})
        assert saved.status_code == 200, saved.text
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current
    base = f"/api/cases/{case}/revisions/{current['revision']['id']}"
    assert all(not row['issues'] for row in client.get(base + '/records').json()['items'])
    bundle = client.get(base + '/artifacts').json()
    artifact = next(a for a in bundle['artifacts'] if a['role'] == role)
    preview = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
    assert {r[preview['columns'].index('MSISDN')] for r in preview['items']} == {'79937967877', '79937967878'}
    assert not any(a['role'] == 'ERRORS' for a in bundle['artifacts'])
    assert client.get(f"/api/cases/{case}/sources/{state['source']['id']}/raw").content == data.encode('utf-8-sig')


def test_bulk_prefix_covers_unloaded_rows_and_later_manual_edit_is_not_overwritten(backend, tmp_path):
    seed(backend)
    client = backend.client()
    from dataclasses import replace
    from app.main import create_app
    backend.settings = replace(backend.settings, max_upload_bytes=200_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    # More than one API page: a bulk decision must never depend on loaded rows.
    data = ('MSISDN\n' + ''.join(f'{9937960000 + i}\n' for i in range(501)) + '001900\n').encode()
    received = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': 'DELETE'},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('phones.csv', data)})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        case, revision = state['intake']['case_id'], state['revision']['id']
        first = client.get(f'/api/cases/{case}/revisions/{revision}/records').json()['items'][0]
        body = {'operation_id': str(uuid4()), 'expected_revision_id': revision,
                'source_asset_id': state['source']['id'], 'prefix_msisdn': True,
                'corrections': [{'record_id': first['record_id'], 'ordinal': 1, 'field': 'MSISDN',
                    'before': '79937960000', 'after': '79937969999', 'reason': 'Manual draft before bulk confirmation'}]}
        path = f'/api/cases/{case}/processing/save-and-start'
        accepted = client.post(path, json=body)
        assert accepted.status_code == 200, accepted.text
        assert client.post(path, json=body).json()['id'] == accepted.json()['id']
        drive(backend, settings, intake_id)
        current = client.get(f'/api/intakes/{intake_id}').json()
        assert current['job']['state'] == 'PREPARED', current
        base = f"/api/cases/{case}/revisions/{current['revision']['id']}"
        page = client.get(base + '/records', params={'after': 500}).json()
        assert [r['effective']['MSISDN'] for r in page['items']] == ['79937960500', '001900']
        assert current['job']['summary']['counts']['DELETE'] == 502
        # One compact audited event, independent of source size.
        assert len(current['revision']['correction_overlay']) == 2
        assert sum(c.get('action') == 'prefix_ten_digit_msisdn' for c in current['revision']['correction_overlay']) == 1
        assert client.get(base + '/records').json()['items'][0]['effective']['MSISDN'] == '79937969999'
        assert current['revision']['correction_overlay'][0]['author_id']
        row = page['items'][0]
        edited = client.post(path, json={'operation_id': str(uuid4()),
            'expected_revision_id': current['revision']['id'], 'source_asset_id': state['source']['id'],
            'corrections': [{'record_id': row['record_id'], 'ordinal': row['ordinal'], 'field': 'MSISDN',
                             'before': '79937960500', 'after': '9937960501', 'reason': 'Explicit later edit'}]})
        assert edited.status_code == 200, edited.text
        drive(backend, settings, intake_id)
        latest = client.get(f'/api/intakes/{intake_id}').json()
        assert latest['job']['summary']['counts']['DELETE'] == 501
        latest_base = f"/api/cases/{case}/revisions/{latest['revision']['id']}"
        detail = client.get(latest_base + f"/records/{row['record_id']}", params={'ordinal': row['ordinal']}).json()
        assert detail['record']['effective']['MSISDN'] == '9937960501'
        assert any(i['code'] == 'msisdn_country_prefix' for i in detail['issues'])
    assert client.get(f"/api/cases/{case}/sources/{state['source']['id']}/raw").content == data
