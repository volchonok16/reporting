"""Real PostgreSQL compatibility for edits made from old displayed source text."""
from uuid import uuid4

from conftest import new_case, upload


def test_old_displayed_msisdn_can_be_corrected_and_retains_submitted_before(backend):
    client = backend.client()
    case = new_case(client)
    source = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
              '7707083893;+79878384919;Тест;Test;0;1\n').encode()
    uploaded = upload(client, case, data=source).json()['result']
    revision = uploaded['revision']['id']
    prefix = f'/api/cases/{case}/revisions/{revision}'
    row = client.get(prefix + '/records').json()['items'][0]
    assert row['effective']['MSISDN'] == '79878384919'
    saved = client.post(f'/api/cases/{case}/revisions', json={
        'operation_id': str(uuid4()), 'expected_revision_id': revision, 'source_asset_id': uploaded['source']['id'],
        'corrections': [{'record_id': row['record_id'], 'ordinal': row['ordinal'], 'field': 'MSISDN',
                         'before': '+79878384919', 'after': '79000000012', 'reason': 'Confirmed source number'}],
        'overrides': []})
    assert saved.status_code == 200
    change = saved.json()['result']['revision']['correction_overlay'][0]
    assert change['before'] == '79878384919'
    assert change['submitted_before'] == '+79878384919'
