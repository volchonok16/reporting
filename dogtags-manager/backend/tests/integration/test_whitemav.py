import csv
import struct
from datetime import date
from io import BytesIO, StringIO
from uuid import uuid4

import pytest
from openpyxl import Workbook

from processing_helpers import runtime
from test_automatic_intake import drive, seed


def source_bytes(format_, rows):
    rows = [['comment', 'phonenumber'], *rows]
    if format_ == 'numbers':
        import tempfile
        from pathlib import Path
        from numbers_parser import Document
        with tempfile.TemporaryDirectory() as directory:
            book = Document(num_rows=len(rows), num_cols=2)
            table = book.sheets[0].tables[0]
            for rn, row in enumerate(rows):
                for cn, value in enumerate(row):
                    table.write(rn, cn, value)
            target = Path(directory) / 'source.numbers'
            book.save(target)
            return target.read_bytes()
    if format_ == 'csv':
        return ('\n'.join(';'.join(r) for r in rows) + '\n').encode('utf-8-sig')
    if format_ == 'xlsx':
        book = Workbook()
        for row in rows:
            book.active.append(row)
        buffer = BytesIO()
        book.save(buffer)
        return buffer.getvalue()

    def record(code, data):
        return struct.pack('<HH', code, len(data)) + data

    data = record(0x0009, struct.pack('<HH', 0x0002, 0x0010))
    for rn, row in enumerate(rows):
        for cn, value in enumerate(row):
            encoded = value.encode('ascii')
            data += record(0x0004, struct.pack('<HH', rn, cn) + b'\x00\x00\x00' + bytes([len(encoded)]) + encoded)
    return data + record(0x000a, b'')


def prepare(backend, tmp_path, format_, rows, *, inn=None):
    seed(backend)
    from dataclasses import replace
    from app.main import create_app
    backend.settings = replace(backend.settings, max_upload_bytes=200_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    data = source_bytes(format_, rows)
    received = client.post('/api/intakes', params={'operation': 'WHITEMAV', **({'whitemav_inn': inn} if inn else {})},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': (f'phones.{format_}', data)})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    return client, intake_id, state, base, data


@pytest.mark.parametrize('format_', ['csv', 'xlsx', 'xls', 'numbers'])
@pytest.mark.parametrize('inn', [None, '7707083893'])
def test_whitemav_without_partner_prepares_approves_and_downloads_only_numbers(backend, tmp_path, format_, inn):
    client, _, state, base, raw = prepare(backend, tmp_path, format_, [
        ['Ignored', '79937967877'], ['Different', '79937967877'], ['Comment', '79937967878']], inn=inn)
    bundle = client.get(base + '/artifacts').json()
    assert {a['role'] for a in bundle['artifacts']} == {'NUMBERS', 'ZIP'}
    assert bundle['manifest']['counts'] == {'NUMBERS': 2}
    numbers = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
    stamp = date.fromisoformat(bundle['manifest']['naming']['formed_on']).strftime('%d.%m.%y')
    assert numbers['download_filename'] == f'WhiteMAV_NUMBERS_{stamp}.csv'
    case, revision = state['intake']['case_id'], state['revision']['id']
    approved = client.post(f'/api/cases/{case}/approval', json={'operation_id': str(uuid4()),
        'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
    assert approved.status_code == 200, approved.text
    response = client.get(base + f"/artifacts/{numbers['id']}/download", params={
        'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
    assert response.status_code == 200, response.text
    rows = list(csv.DictReader(StringIO(response.content.decode('cp1251')), delimiter=';'))
    assert [r['MSISDN'] for r in rows] == ['79937967877', '79937967878']
    assert all({k: v for k, v in r.items() if k != 'MSISDN'} == {
        'INN': inn or '7743895280', 'MAV_LABEL_NAME': '', 'IS_MAV': '1', 'IS_KSS': '0',
        'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'whiteMAV'} for r in rows)
    assert client.get(f"/api/cases/{case}/sources/{state['source']['id']}/raw").content == raw


def test_whitemav_errors_can_be_corrected_but_fixed_values_cannot_be_overridden(backend, tmp_path):
    client, intake_id, state, base, _ = prepare(backend, tmp_path, 'csv', [
        ['Ignored', '9937967877'], ['Ignored', '79937967878']])
    row = client.get(base + '/records').json()['items'][0]
    assert row['issues'][0]['code'] == 'msisdn_country_prefix'
    case = state['intake']['case_id']
    body = {'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
            'source_asset_id': state['source']['id'], 'prefix_msisdn': True}
    invalid = client.post(f'/api/cases/{case}/processing/save-and-start', json={**body,
        'overrides': [{'field': 'INTERNAL_OPERATOR_NAME', 'before': 'whiteMAV', 'after': 'Other', 'reason': 'Test'}]})
    assert invalid.status_code == 422, invalid.text
    accepted = client.post(f'/api/cases/{case}/processing/save-and-start', json=body)
    assert accepted.status_code == 200, accepted.text
    with runtime(backend, tmp_path / 'corrected') as settings:
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current
    assert current['job']['summary']['counts'] == {'NUMBERS': 2}


def test_whitemav_legacy_profile_is_preserved_and_new_revision_uses_lowercase_operator(backend, tmp_path, monkeypatch):
    from uuid import UUID
    from app.domain.operations import canonical_digest
    from app.models import ProcessingRevision, SourceProfileVersion
    legacy = {'partner': 'WhiteMAV', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'WhiteMAV'}
    with backend.app.state.sessions() as db:
        profile = SourceProfileVersion(version='whitemav-fixed-v1', snapshot=legacy, config_hash=canonical_digest(legacy))
        db.add(profile)
        db.commit()
        legacy_id = profile.id
    from app.domain import whitemav
    with monkeypatch.context() as patch:
        patch.setattr(whitemav, 'fixed_profile', lambda db: db.get(SourceProfileVersion, legacy_id))
        client, intake_id, state, _, _ = prepare(backend, tmp_path, 'csv', [['Ignored', '79937967877']])
    assert state['revision']['profile_snapshot']['INTERNAL_OPERATOR_NAME'] == 'WhiteMAV'
    previous_id = UUID(state['revision']['id'])
    response = client.post(f"/api/cases/{state['intake']['case_id']}/processing/save-and-start", json={
        'operation_id': str(uuid4()), 'expected_revision_id': str(previous_id), 'source_asset_id': state['source']['id']})
    assert response.status_code == 200, response.text
    with runtime(backend, tmp_path / 'restarted') as settings:
        drive(backend, settings, intake_id)
    current = client.get('/api/intakes/' + intake_id).json()
    assert current['job']['state'] == 'PREPARED', current
    assert current['revision']['profile_snapshot']['INTERNAL_OPERATOR_NAME'] == 'whiteMAV'
    with backend.app.state.sessions() as db:
        assert db.get(SourceProfileVersion, legacy_id).snapshot == legacy
        assert db.get(ProcessingRevision, previous_id).profile_snapshot == legacy
