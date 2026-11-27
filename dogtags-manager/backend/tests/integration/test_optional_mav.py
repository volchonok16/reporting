"""Missing source flags default, while supplied flags retain their validation."""
import csv
from dataclasses import replace
from io import BytesIO, StringIO
from uuid import uuid4

import pytest

from processing_helpers import runtime
from app.main import create_app
from test_automatic_intake import drive, seed, receive


@pytest.mark.parametrize('format_', ['csv', 'xlsx'])
def test_alias_upload_without_mav_produces_exact_zero_in_numbers(backend, tmp_path, format_):
    seed(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=100_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    columns = ['labelLatin', 'phonenumber', 'INN', 'IS_KSS', 'label']
    row = ['Test', '001900', '7805406976', '1', 'Тест']
    if format_ == 'xlsx':
        from openpyxl import Workbook
        book = Workbook()
        book.active.append(columns)
        book.active.append(row)
        buffer = BytesIO()
        book.save(buffer)
        data = buffer.getvalue()
    else:
        data = (';'.join(columns) + '\r\n' + ';'.join(row) + '\r\n').encode('utf-8-sig')
    received = client.post('/api/intakes', params={'partner': 'RTK HUB'},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': (f'source.{format_}', data)})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['assessment']['result']['field_defaults'] == {'IS_MAV': '0'}
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    records = client.get(base + '/records').json()['items']
    assert records[0]['effective']['IS_MAV'] == '0' and not records[0]['issues']
    bundle = client.get(base + '/artifacts').json()
    assert bundle['manifest']['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    approval = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']})
    assert approval.status_code == 200, approval.text
    artifact = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
    response = client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert response.status_code == 200, response.text
    output = list(csv.DictReader(StringIO(response.content.decode('cp1251')), delimiter=';'))
    assert output[0]['IS_MAV'] == '0' and output[0]['MSISDN'] == '001900'


def test_manual_mapping_can_omit_mav_and_uses_zero(backend, tmp_path):
    seed(backend)
    client = backend.client()
    data = ('\ufeffA;B;C;D;E\n7805406976;001900;Тест;Test;1\n').encode()
    intake_id = receive(client, data=data).json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        saved = client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'partner': 'RTK HUB', 'operation': 'ADD', 'mapping': {
                'INN': 0, 'MSISDN': 1, 'MAV_LABEL_NAME': 2, 'MAV_LABEL_LATIN': 3, 'IS_KSS': 4}}})
        assert saved.status_code == 200, saved.text
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current
    assert current['assessment']['result']['field_defaults'] == {'IS_MAV': '0'}


@pytest.mark.parametrize('flag', ['', '2', '1'])
def test_existing_mav_cells_are_never_replaced_by_default(backend, tmp_path, flag):
    seed(backend)
    client = backend.client()
    data = ('\ufeffINN;phonenumber;label;labelLatin;IS_MAV;IS_KSS\n'
            f'7805406976;001900;Тест;Test;{flag};0\n').encode()
    intake_id = receive(client, data=data).json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['assessment']['result']['field_defaults'] == {}
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    record = client.get(base + '/records').json()['items'][0]
    assert record['effective']['IS_MAV'] == flag
    assert any(i['code'] == 'flag_value' for i in record['issues']) == (flag != '1')


def test_returned_numbers_without_mav_column_use_zero(backend, tmp_path):
    seed(backend)
    client = backend.client()
    data = ('\ufeffINN;phonenumber;label;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME;STATUS\n'
            '7805406976;001900;Тест;1;0;hubRTK;\n').encode()
    received = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': 'REPAIR'},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('numbers.csv', data)})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    record = client.get(base + '/records').json()['items'][0]
    assert record['effective']['IS_MAV'] == '0' and not record['issues']
    assert client.get(base + '/artifacts').json()['manifest']['counts'] == {'NUMBERS': 1}


@pytest.mark.parametrize('flags, expected', [({}, ('', '')), ({'IS_MAV': '1', 'IS_KSS': '1'}, ('1', '0'))])
def test_assignment_can_defer_missing_fields_or_supply_flags(backend, tmp_path, flags, expected):
    seed(backend)
    client = backend.client()
    intake_id = receive(client, data=b'\xef\xbb\xbfphonenumber;labelLatin\n001900;Test\n').json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        saved = client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'partner': 'RTK HUB', 'operation': 'ADD',
                          'mapping': {'MSISDN': 0, 'MAV_LABEL_LATIN': 1}, 'missing_flags': flags}})
        assert saved.status_code == 200, saved.text
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    values = client.get(base + '/records').json()['items'][0]['effective']
    assert (values['IS_MAV'], values['IS_KSS']) == expected
    assert values['INN'] == values['MAV_LABEL_NAME'] == ''
