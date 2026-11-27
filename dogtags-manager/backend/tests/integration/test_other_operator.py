"""DELETE recovery is operator-scoped; every other row stays in a full-source report."""
import csv
from io import StringIO
from uuid import uuid4

from test_status_repair import prepare

STATUS = 'Номер телефона уже есть в таблице MAV номеров'
COLUMNS = ['Комментарий', 'INN', 'MAV_OPERATOR_NAME', 'MAV_LABEL_NAME', 'MSISDN',
           'IS_MAV', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME', 'STATUS']


def test_delete_is_restricted_to_exact_operator_and_other_report_is_downloadable(backend, tmp_path):
    operators = ['mTELE2', 'Other 😀', 'mtele2', 'mTELE2 ', '']
    rows = [[f'keep-{i}', '7805406976', operator, 'Тест', f'00{i}900', '1', '0', '0', 'hubRTK', STATUS]
            for i, operator in enumerate(operators, 1)]
    rows.append(['ordinary', '7805406976', 'Other', 'Тест', '006900', '1', '0', '0', 'hubRTK', ''])
    client, _, state, base, bundle = prepare(backend, tmp_path, COLUMNS, rows)
    assert bundle['manifest']['counts'] == {'NUMBERS': 1, 'DELETE': 1, 'ERROR_OTHER_OPERATOR': 4}
    assert bundle['manifest']['output_spec']['diagnostic_roles'] == ['ERROR_OTHER_OPERATOR']
    records = client.get(base + '/records').json()['items']
    assert records[0]['effective']['MAV_OPERATOR_NAME'] == 'mTELE2'
    assert [r['ordinal'] for r in records if any(i['code'] == 'other_operator' for i in r['issues'])] == [2, 3, 4, 5]
    assert client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']}).status_code == 200
    for role in ('DELETE', 'ERROR_OTHER_OPERATOR'):
        artifact = next(a for a in bundle['artifacts'] if a['role'] == role)
        preview = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
        response = client.get(base + f"/artifacts/{artifact['id']}/download", params={
            'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
        assert response.status_code == 200, response.text
        if role == 'DELETE':
            assert response.content == b'MSISDN\r\n001900\r\n'
            assert preview['columns'] == ['MSISDN']
        else:
            assert '_ERROR_OTHER_OPERATOR_' in artifact['download_filename']
            assert 'utf-8' in response.headers['content-type']
            assert response.content.startswith(b'\xef\xbb\xbf')
            output = list(csv.reader(StringIO(response.content.decode('utf-8-sig')), delimiter=';'))
            assert output == [COLUMNS, *rows[1:5]]
            assert preview['columns'][:len(COLUMNS)] == COLUMNS
            assert len(preview['items']) == 4
    report = next(a for a in bundle['artifacts'] if a['role'] == 'ERROR_OTHER_OPERATOR')
    assert client.post('/api/external-attempts', json={
        'operation_id': str(uuid4()), 'artifact_id': report['id'], 'artifact_set_id': bundle['artifact_set_id'],
        'manifest_hash': bundle['manifest_hash'], 'predecessor_ids': [], 'reason': 'Diagnostic only'}).status_code == 422


def test_missing_operator_column_produces_report_without_delete(backend, tmp_path):
    columns = [column for column in COLUMNS if column != 'MAV_OPERATOR_NAME']
    row = ['keep', '7805406976', 'Тест', '001900', '1', '0', '0', 'hubRTK', STATUS]
    client, _, _, base, bundle = prepare(backend, tmp_path, columns, [row])
    assert bundle['manifest']['counts'] == {'ERROR_OTHER_OPERATOR': 1}
    assert any(i['code'] == 'other_operator' for i in client.get(base + '/records').json()['items'][0]['issues'])
