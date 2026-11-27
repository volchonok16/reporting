"""Actual new-source preparation, page-owned diagnostics, release and save receipts."""
import csv
from dataclasses import replace
from io import StringIO
from uuid import uuid4

import pytest

from app.main import create_app
from processing_helpers import runtime
from test_automatic_intake import drive, seed


def prepared(backend, tmp_path, rows, *, partner='RTK HUB', delete=False, legacy=False):
    seed(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=200_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    stream = StringIO(newline='')
    writer = csv.writer(stream, delimiter=';', lineterminator='\r\n')
    writer.writerow(['MSISDN'] if delete else ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS'])
    writer.writerows(rows)
    response = client.post('/api/intakes', params={'partner': partner, 'operation': 'DELETE' if delete else 'ADD'},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('source.csv', stream.getvalue().encode('utf-8-sig'))})
    assert response.status_code == 200, response.text
    intake_id = response.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as configuration:
        if legacy:
            # Seed the historical configuration before INSERT, rather than
            # violating the database's immutable-revision guard.
            from sqlalchemy import event
            from app.models import ProcessingRevision
            from app.domain.output_spec import output_spec
            from app.domain.operations import canonical_digest
            def historical_configuration(mapper, connection, revision):
                saved = dict(revision.settings)
                saved.pop('filename_policy')
                saved.pop('row_error_policy')
                saved['output_spec'] = output_spec(saved['operation'])
                revision.settings = saved
                revision.config_hash = canonical_digest({'profile': revision.profile_snapshot, 'settings': saved,
                    'assessment_id': str(revision.assessment_id), 'correction_overlay': revision.correction_overlay})
            event.listen(ProcessingRevision, 'before_insert', historical_configuration)
            try:
                drive(backend, configuration, intake_id)
            finally:
                event.remove(ProcessingRevision, 'before_insert', historical_configuration)
        else:
            drive(backend, configuration, intake_id)
        drive(backend, configuration, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state['job'].get('error')
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    bundle = client.get(base + '/artifacts').json()
    assert bundle['available'], bundle
    return client, intake_id, state, base, bundle


@pytest.mark.parametrize('partner,token', [('RTK HUB', 'RTK_HUB'), ('RTK ABC', 'RTK_ABC'), ('RTK MVNO', 'RTK_MVNO'), ('ГПБМ', 'GPBM')])
def test_main_and_source_report_are_confirmable_exact_named_csvs(backend, tmp_path, partner, token):
    rows = [['1234567894', '001900', 'Тест', 'Test', '1', '0'],
            ['bad', '002900', 'Ошибка№', 'Error', '1', '0']]
    client, _, state, base, bundle = prepared(backend, tmp_path, rows, partner=partner)
    assert bundle['manifest']['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1, 'ERRORS': 1}
    records = client.get(base + '/records').json()['items']
    assert records[0]['issues'] == []
    assert {issue['field'] for issue in records[1]['issues']} == {'INN', 'MAV_LABEL_NAME'}
    assert len(records[1]['issues']) == 2
    detail = client.get(base + f"/records/{records[1]['record_id']}?ordinal=2").json()
    assert detail['record']['issues'] == records[1]['issues']
    assert detail['record']['issue_fields'] == records[1]['issue_fields']
    assert {(issue['field'], issue['code']) for issue in detail['issues']} == {
        (issue['field'], issue['code']) for issue in detail['record']['issues']}
    from datetime import date
    naming = bundle['manifest']['naming']
    date_stamp = date.fromisoformat(naming['formed_on']).strftime('%d.%m.%y')
    approved = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert approved.status_code == 200, approved.text
    for artifact in bundle['artifacts']:
        role = artifact['role']
        name_role = 'FILES' if role == 'ZIP' else 'SOURCE_ERRORS' if role == 'ERRORS' else role
        extension = 'zip' if role == 'ZIP' else 'csv'
        assert artifact['download_filename'] == f'{token}_{name_role}_{date_stamp}.{extension}'
        downloaded = client.get(base + f"/artifacts/{artifact['id']}/download", params={
            'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
        assert downloaded.status_code == 200, downloaded.text
        if role == 'ERRORS':
            assert 'utf-8' in downloaded.headers['content-type']
            assert downloaded.content.startswith(b'\xef\xbb\xbf')
            assert downloaded.content.count(b'\xef\xbb\xbf') == 1
            report = list(csv.DictReader(StringIO(downloaded.content.decode('utf-8-sig')), delimiter=';'))
            assert len(report) == 1 and report[0]['INN'] == 'bad'
            assert list(report[0]) == ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS', 'Ошибка']
            labels = {'INN': 'ИНН', 'MAV_LABEL_NAME': 'Этикетка на русском'}
            expected = {labels[issue['field']] + ': ' + issue['message'] for issue in records[1]['issues']}
            assert set(report[0]['Ошибка'].splitlines()) == expected
            assert 'В этикетке на кириллице найдены недопустимые символы: позиция 7: «№»' in report[0]['Ошибка']
            assert 'U+' not in report[0]['Ошибка']
            preview = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
            assert preview['items'][0][preview['columns'].index('Ошибка')] == report[0]['Ошибка']
        elif role == 'NUMBERS':
            assert not downloaded.content.startswith(b'\xef\xbb\xbf')
            output = list(csv.DictReader(StringIO(downloaded.content.decode('cp1251')), delimiter=';'))
            assert len(output) == 1 and output[0]['MSISDN'] == '001900'


def test_visible_row501_has_every_error_without_loading_issue_pages(backend, tmp_path):
    rows = [['1234567894', f'{i:08}', 'Тест', 'A' * 34, 'wrong', '0'] for i in range(501)]
    client, _, _, base, bundle = prepared(backend, tmp_path, rows)
    assert bundle['manifest']['counts'] == {'ERRORS': 501}
    page = client.get(base + '/records?after=500&limit=500')
    assert page.status_code == 200, page.text
    row = page.json()['items'][0]
    assert row['ordinal'] == 501
    assert {issue['field'] for issue in row['issues']} == {'IS_MAV', 'MAV_LABEL_LATIN'}
    assert len(row['issues']) == 2
    assert all(issue['message'] and issue['code'] and issue['scope'] for issue in row['issues'])


def test_new_delete_ignores_blank_number_rows_without_fake_error_files(backend, tmp_path):
    client, _, _, base, bundle = prepared(backend, tmp_path, [['001900'], ['']], delete=True)
    assert bundle['manifest']['counts'] == {'DELETE': 1}
    records = client.get(base + '/records').json()['items']
    assert len(records) == 1 and not records[0]['issues']
    assert not any(a['role'] == 'ERRORS' for a in bundle['artifacts'])


def test_delete_source_error_report_contains_the_displayed_error(backend, tmp_path):
    client, _, state, base, bundle = prepared(backend, tmp_path, [['001900'], ['002😀']], delete=True)
    assert bundle['manifest']['counts'] == {'DELETE': 1, 'ERRORS': 1}
    row = client.get(base + '/records').json()['items'][1]
    approved = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']})
    assert approved.status_code == 200, approved.text
    artifact = next(a for a in bundle['artifacts'] if a['role'] == 'ERRORS')
    downloaded = client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert downloaded.status_code == 200, downloaded.text
    report = list(csv.DictReader(StringIO(downloaded.content.decode('utf-8-sig')), delimiter=';'))
    assert report == [{'MSISDN': '002😀', 'Ошибка': 'Номер: ' + row['issues'][0]['message']}]


def test_save_rechecks_errors_and_replay_never_duplicates_revision_or_changes_old_bundle(backend, tmp_path):
    rows = [['1234567894', '001900', 'Тест', 'A' * 34, '1', '0']]
    client, intake_id, state, base, bundle = prepared(backend, tmp_path, rows)
    assert bundle['manifest']['counts'] == {'ERRORS': 1}
    records = client.get(base + '/records').json()['items']
    body = {'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['source']['id'], 'corrections': [{
            'record_id': records[0]['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_LATIN',
            'before': 'A' * 34, 'after': 'Test', 'reason': 'Исправление оператором'}]}
    path = f"/api/cases/{state['intake']['case_id']}/processing/save-and-start"
    saved = client.post(path, json=body)
    assert saved.status_code == 200, saved.text
    assert client.post(path, json=body).json()['id'] == saved.json()['id']
    with runtime(backend, tmp_path / 'saved') as configuration:
        drive(backend, configuration, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    current_base = f"/api/cases/{state['intake']['case_id']}/revisions/{current['revision']['id']}"
    assert current['job']['state'] == 'PREPARED', current['job'].get('error')
    assert client.get(current_base + '/artifacts').json()['manifest']['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    assert client.get(current_base + '/records').json()['items'][0]['issues'] == []
    assert client.get(base + '/artifacts').json()['manifest_hash'] == bundle['manifest_hash']


def test_new_save_of_archived_legacy_preparation_adopts_short_names_without_rewriting_history(backend, tmp_path):
    rows = [['1234567894', '001900', 'Тест', 'Test', '1', '0']]
    client, intake_id, state, base, bundle = prepared(backend, tmp_path, rows, legacy=True)
    assert 'naming' not in bundle['manifest']
    assert all('_MARKING_' not in a['download_filename'] for a in bundle['artifacts'])
    assert all('_PREPARED_' in a['download_filename'] for a in bundle['artifacts'])
    case_id = state['intake']['case_id']
    approved = client.post(f'/api/cases/{case_id}/approval', json={'operation_id': str(uuid4()),
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert approved.status_code == 200, approved.text
    artifact = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
    downloaded = client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert downloaded.status_code == 200
    record = client.get(base + '/records').json()['items'][0]
    saved = client.post(f'/api/cases/{case_id}/processing/save-and-start', json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['source']['id'], 'corrections': [{
            'record_id': record['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_LATIN',
            'before': 'Test', 'after': 'New', 'reason': 'Новая обработка архивного исходника'}]})
    assert saved.status_code == 200, saved.text
    with runtime(backend, tmp_path / 'new') as configuration:
        drive(backend, configuration, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current['job'].get('error')
    new_base = f"/api/cases/{case_id}/revisions/{current['revision']['id']}"
    assert client.get(new_base + '/artifacts').json()['manifest']['naming']['version'] == 'short-output-v1'
    old = client.get(base + '/artifacts').json()
    assert old['manifest'] == bundle['manifest']
    assert [a['download_filename'] for a in old['artifacts']] == [a['download_filename'] for a in bundle['artifacts']]
    assert client.get(base + f"/artifacts/{artifact['id']}/preview").status_code == 200
