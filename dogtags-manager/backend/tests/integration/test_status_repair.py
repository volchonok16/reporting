"""Returned-file preparation is independent of external success evidence."""
import csv
from dataclasses import replace
from io import StringIO
from uuid import uuid4

import pytest

from app.main import create_app
from processing_helpers import runtime
from test_automatic_intake import drive, seed


def prepare(backend, tmp_path, columns, rows):
    seed(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=100_000, max_page_size=500)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    stream = StringIO(newline='')
    writer = csv.writer(stream, delimiter=';', lineterminator='\r\n')
    writer.writerow(columns)
    writer.writerows(rows)
    key = str(uuid4())
    params = {'partner': 'RTK HUB', 'operation': 'REPAIR'}
    request = dict(params=params, headers={'X-Operation-ID': key},
                   files={'file': ('return.csv', stream.getvalue().encode('utf-8-sig'), 'text/csv')})
    response = client.post('/api/intakes', **request)
    assert response.status_code == 200, response.text
    assert client.post('/api/intakes', **request).json()['id'] == response.json()['id']
    intake_id = response.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state.get('assessment', {}).get('questions') or state['job']
    assert state['assessment']['result']['operation'] == 'REPAIR'
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    bundle = client.get(base + '/artifacts').json()
    assert bundle['available'], bundle
    assert bundle['manifest']['reconciliation']['complete']
    return client, intake_id, state, base, bundle


@pytest.mark.parametrize('role,columns,rows,expected', [
    ('CLIENTS', ['COMPANY_NAME', 'COMPANY_CONTRACT', 'MAV_OPERATOR_NAME', 'INN', 'STATUS'],
     [['', '', '', '7707083893', 'ИНН уже есть в списке MAV клиентов'],
      ['Название', '', '', '1234567894', '']], {'CLIENTS': 1}),
    ('DOGTAGS', ['INN', 'MAV_LABEL', 'MAV_LABEL_LATIN', 'IS_ACTIVE', 'STATUS'],
     [['7707083893', 'Тест', 'Test', '1', 'Указанный MAV_LABEL уже есть у данного клиента'],
      ['1234567894', 'Тест', 'Test', '1', 'ИНН отсутствует в таблице MAV клиентов'],
      ['123456789047', 'Тест', 'Test', '1', '']], {'CLIENTS': 1, 'DOGTAGS': 1}),
    ('NUMBERS', ['INN', 'MAV_OPERATOR_NAME', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS',
                 'SPREADING', 'STATUS', 'INTERNAL_OPERATOR_NAME'],
     [['7707083893', 'mTELE2', 'Тест', '001900', '1', '0', '1',
       'Номер телефона уже есть в таблице MAV номеров', 'original'],
      ['7707083893', 'drop', 'Тест', '002900', '0', '1', '1',
       'MAV_LABEL_NAME отсутствует в таблице этикеток', 'original'],
      ['1234567894', 'drop', 'Тест', '003900', '0', '1', '1', '', 'original']],
     {'NUMBERS': 1, 'DELETE': 1}),
])
def test_status_actions_export_only_exact_contracts_and_never_infer_application(
        backend, tmp_path, role, columns, rows, expected):
    client, intake_id, state, base, bundle = prepare(backend, tmp_path, columns, rows)
    assert bundle['manifest']['counts'] == expected
    records = client.get(base + '/records?limit=500')
    assert records.status_code == 200 and len(records.json()['items']) == len(rows)
    assert client.get(base + '/records?limit=501').status_code == 422
    approval = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']})
    assert approval.status_code == 200, approval.text
    from app.domain.output_spec import file_definition
    for artifact in bundle['artifacts']:
        if artifact['role'] == 'ZIP':
            continue
        preview = client.get(base + f"/artifacts/{artifact['id']}/preview?limit=500")
        assert preview.status_code == 200, preview.text
        output = preview.json()
        assert output['columns'] == file_definition(artifact['role'], 'DELETE' if artifact['role'] == 'DELETE' else 'ADD')['columns']
        assert 'STATUS' not in output['columns']
        if artifact['role'] == 'NUMBERS':
            assert 'MAV_OPERATOR_NAME' not in output['columns']
            assert output['items'][0][-2:] == ['1', 'original']
        download = client.get(base + f"/artifacts/{artifact['id']}/download", params={
            'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
        assert download.status_code == 200, download.text
        assert download.content.decode('cp1251').endswith('\r\n')
    archive = client.get('/api/intakes').json()['items']
    record = next(item for item in archive if item['intake']['id'] == intake_id)
    assert {item['role'] for item in record['output_files']} == {*expected, 'ZIP'}
    from sqlalchemy import select, func
    from app.models import ExternalAttempt, EvidenceEvent
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ExternalAttempt)) == 0
        assert db.scalar(select(func.count()).select_from(EvidenceEvent)) == 0


def test_blank_status_format_errors_remain_editable_and_old_approval_is_revoked(backend, tmp_path):
    columns = ['INN', 'MAV_LABEL', 'MAV_LABEL_LATIN', 'IS_ACTIVE', 'STATUS']
    rows = [['7707083893', 'Тест', 'A' * 34, '1', ''],
            ['1234567894', 'Тест', 'Test', '1', ''],
            ['123456789047', 'Ошибка№', 'Error', '1',
             'Длина MAV_LABEL не должна превышать 32 символа или имеются некорретные символы']]
    client, intake_id, state, base, bundle = prepare(backend, tmp_path, columns, rows)
    assert bundle['manifest']['counts'] == {'DOGTAGS': 1, 'ERRORS': 2}
    records = client.get(base + '/records').json()['items']
    detail = client.get(base + f"/records/{records[0]['record_id']}?ordinal=1")
    assert detail.status_code == 200, detail.text
    assert any(issue['field'] == 'MAV_LABEL_LATIN' for issue in detail.json()['issues'])
    report = next(item for item in bundle['artifacts'] if item['role'] == 'ERRORS')
    preview = client.get(base + f"/artifacts/{report['id']}/preview").json()
    assert len(preview['items']) == 2 and 'ERROR_FIELDS' in preview['columns']
    assert preview['columns'] == [*columns, 'SOURCE_ROW', 'ERROR_FIELDS', 'ERROR_MESSAGES']
    assert preview['items'][1][preview['columns'].index('ERROR_FIELDS')] == 'MAV_LABEL'
    assert client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']}).status_code == 200
    downloaded = client.get(base + f"/artifacts/{report['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert downloaded.status_code == 200
    assert 'Ошибка№' in downloaded.content.decode('utf-8-sig')
    import csv
    from io import StringIO
    downloaded_rows = list(csv.reader(StringIO(downloaded.content.decode('utf-8-sig')), delimiter=';'))
    assert downloaded_rows == [columns, rows[0], rows[2]]
    assert bundle['manifest']['output_spec']['encoding_by_role']['ERRORS'] == 'utf-8'
    saved = client.post(f"/api/cases/{state['intake']['case_id']}/processing/save-and-start", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['revision']['source']['id'], 'corrections': [{
            'record_id': records[0]['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_LATIN',
            'before': 'A' * 34, 'after': 'Test', 'reason': 'Подтверждённое сокращение'}]})
    assert saved.status_code == 200, saved.text
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    current_base = f"/api/cases/{state['intake']['case_id']}/revisions/{current['revision']['id']}"
    assert current['job']['state'] == 'PREPARED', current
    assert client.get(current_base + '/artifacts').json()['manifest']['counts'] == {'DOGTAGS': 2, 'ERRORS': 1}
    assert client.get(base + f"/artifacts/{report['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']}).status_code == 409


def test_diagnostic_report_cannot_be_recorded_as_an_external_submission(backend, tmp_path):
    client, _, _, base, bundle = prepare(backend, tmp_path, ['INN', 'STATUS'],
        [['7707083893', 'Неизвестная ошибка внешней базы']])
    assert bundle['manifest']['counts'] == {'ERRORS': 1}
    report = next(item for item in bundle['artifacts'] if item['role'] == 'ERRORS')
    response = client.post('/api/external-attempts', json={
        'operation_id': str(uuid4()), 'artifact_id': report['id'],
        'artifact_set_id': bundle['artifact_set_id'], 'manifest_hash': bundle['manifest_hash'],
        'reason': 'Диагностический файл не предназначен для загрузки'})
    assert response.status_code == 422, response.text
    assert response.json()['error']['code'] == 'attempt_requires_csv'
    assert client.get(base + '/records').json()['items'][0]['disposition'] == 'excluded_error'


def test_returned_numbers_edit_source_parameters_and_exclude_rows(backend, tmp_path):
    columns = ['INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS',
               'SPREADING', 'INTERNAL_OPERATOR_NAME', 'STATUS']
    rows = [['7707083893', 'Тест', '900', '1', '0', '1', 'original', ''],
            ['7707083893', 'Тест', '901', '1', '0', '1', 'original', '']]
    client, intake_id, state, base, _ = prepare(backend, tmp_path, columns, rows)
    records = client.get(base + '/records').json()['items']
    response = client.post(f"/api/cases/{state['intake']['case_id']}/processing/save-and-start", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['source']['id'], 'corrections': [
            {'record_id': records[0]['record_id'], 'ordinal': 1, 'field': field,
             'before': before, 'after': after, 'reason': 'Подтверждённое изменение'}
            for field, before, after in [('SPREADING', '1', '0'),
                                         ('INTERNAL_OPERATOR_NAME', 'original', 'corrected')]],
        'row_selections': [{'record_id': records[1]['record_id'], 'ordinal': 2,
                            'before': False, 'excluded': True}]})
    assert response.status_code == 200, response.text
    with runtime(backend, tmp_path / 'edited') as settings:
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    current_base = f"/api/cases/{state['intake']['case_id']}/revisions/{current['revision']['id']}"
    bundle = client.get(current_base + '/artifacts').json()
    assert bundle['available'] and bundle['manifest']['counts'] == {'NUMBERS': 1}
    artifact = next(item for item in bundle['artifacts'] if item['role'] == 'NUMBERS')
    preview = client.get(current_base + f"/artifacts/{artifact['id']}/preview").json()
    assert preview['items'][0][-2:] == ['0', 'corrected']
    assert client.get(current_base + '/records').json()['items'][1]['disposition'] == 'excluded_manual'


def test_visible_records_carry_all_issue_fields_independently_of_issue_pagination(backend, tmp_path):
    client, _, _, base, _ = prepare(backend, tmp_path,
        ['INN', 'MAV_LABEL', 'MAV_LABEL_LATIN', 'IS_ACTIVE', 'STATUS'],
        [['7707083893', 'Тест', 'A' * 34, '0', ''] for _ in range(501)])
    issues = client.get(base + '/issues?limit=500').json()
    assert issues['next_cursor'] is not None
    records = client.get(base + '/records?after=500&limit=500').json()
    assert len(records['items']) == 1
    assert {'MAV_LABEL_LATIN', 'IS_ACTIVE'} <= set(records['items'][0]['issue_fields'])
    first = client.get(base + '/records?limit=500').json()
    assert all({'MAV_LABEL_LATIN', 'IS_ACTIVE'} <= set(row['issue_fields']) for row in first['items'])
