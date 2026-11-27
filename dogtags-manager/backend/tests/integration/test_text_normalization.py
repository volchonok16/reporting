"""Published CSVs contain valid Ё/ё and ordinary spaces, never blank records."""
import csv
from io import StringIO
from uuid import uuid4

from test_source_error_review import prepared


def test_blank_template_rows_and_nonbreaking_spaces_in_real_processing(backend, tmp_path):
    rows = [['7805406976\u00a0', '001234', 'Ёлка\u00a0и\u202fёж', 'Elka\u00a0ezh', '1', '0'],
            ['', '', '', '', '', ''], ['', '', '', '', '', '0'],
            ['7805406976', '', '', '', '', '']]
    client, intake, state, base, bundle = prepared(backend, tmp_path, rows)
    assert bundle['manifest']['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1, 'ERRORS': 1}
    records = client.get(base + '/records').json()['items']
    assert len(records) == 2
    assert records[0]['effective']['MAV_LABEL_NAME'] == 'Ёлка и ёж'
    assert not records[0]['issues']
    assert records[1]['issues']
    original = client.get(f'/api/intakes/{intake}/records').json()['items'][0]
    assert original['cells'][2] == 'Ёлка\u00a0и\u202fёж'
    assert client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']}).status_code == 200
    dogtags = next(a for a in bundle['artifacts'] if a['role'] == 'DOGTAGS')
    response = client.get(base + f"/artifacts/{dogtags['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert response.status_code == 200
    output = list(csv.DictReader(StringIO(response.content.decode('cp1251')), delimiter=';'))
    assert output == [{'INN': '7805406976', 'MAV_LABEL': 'Ёлка и ёж', 'MAV_LABEL_LATIN': 'Elka ezh', 'IS_ACTIVE': '1'}]
    saved = client.post(f"/api/cases/{state['intake']['case_id']}/revisions", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['source']['id'], 'corrections': [{
            'record_id': records[0]['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_NAME',
            'before': 'Ёлка и ёж', 'after': 'Новый\u00a0ёж'}]})
    assert saved.status_code == 200, saved.text
    revision = saved.json()['result']['revision']
    correction = revision['correction_overlay'][0]
    assert correction['after'] == 'Новый ёж' and correction['submitted_after'] == 'Новый\u00a0ёж'
    newer = client.get(f"/api/cases/{state['intake']['case_id']}/revisions/{revision['id']}/records").json()
    assert newer['items'][0]['effective']['MAV_LABEL_NAME'] == 'Новый ёж'
