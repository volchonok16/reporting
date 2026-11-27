"""Automatic receipt → DISCOVER → BUILD, with no browser-owned continuation."""
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from app.admin.publish_rules import publish_rules
from app.domain.rules import seed_config
from app.models import Case, Intake, IntakeVersion, Operation, ProcessingRun, User

DATA = ('\ufeffINN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
        '7707083893;79000000000;Тест;Test;0;1\n').encode()


def seed(backend):
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = [*user.permissions, 'rules.publish']
        publish_rules(db, user, seed_config(), reason='Supplied test contracts')
        db.commit()


def receive(client, *, data=DATA, key=None, partner='RTK HUB'):
    return client.post('/api/intakes', params={'partner': partner} if partner else {},
        headers={'X-Operation-ID': str(key or uuid4())}, files={'file': ('source.csv', data, 'text/csv')})


def drive(backend, settings, intake_id):
    from app.processing.tasks import process_run
    with backend.app.state.sessions() as db:
        intake = db.get(Intake, UUID(str(intake_id)))
        jobs = list(db.scalars(select(ProcessingRun.id).where(ProcessingRun.case_id == intake.case_id,
                                                             ProcessingRun.state == 'QUEUED')))
    for job in jobs:
        process_run(backend.app.state.sessions, job, settings, backend.app.state.storage)


@pytest.mark.parametrize('format_', ['csv', 'numbers'])
def test_gpbm_source_produces_three_files_with_empty_operator(backend, tmp_path, format_):
    from processing_helpers import runtime
    from dataclasses import replace
    from app.main import create_app
    backend.settings = replace(backend.settings, max_upload_bytes=200_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    seed(backend)
    client = backend.client()
    if format_ == 'numbers':
        from numbers_parser import Document
        book = Document(num_rows=2, num_cols=6)
        for rn, row in enumerate(DATA.decode('utf-8-sig').splitlines()):
            for cn, value in enumerate(row.split(';')):
                book.sheets[0].tables[0].write(rn, cn, value)
        path = tmp_path / 'source.numbers'
        book.save(path)
        received = client.post('/api/intakes', params={'partner': 'ГПБМ'},
            headers={'X-Operation-ID': str(uuid4())}, files={'file': (path.name, path.read_bytes())})
    else:
        received = receive(client, partner='ГПБМ')
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as configuration:
        drive(backend, configuration, intake_id)
        drive(backend, configuration, intake_id)
    state = client.get('/api/intakes/' + intake_id).json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['revision']['profile_snapshot']['partner'] == 'ГПБМ'
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    bundle = client.get(base + '/artifacts').json()
    assert {item['role'] for item in bundle['artifacts']} == {'CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP'}
    numbers = next(item for item in bundle['artifacts'] if item['role'] == 'NUMBERS')
    assert numbers['download_filename'].startswith('GPBM_NUMBERS_')
    preview = client.get(base + f"/artifacts/{numbers['id']}/preview").json()
    assert preview['items'][0][-2:] == ['1', '']
    approved = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'manifest_hash': bundle['manifest_hash']})
    assert approved.status_code == 200, approved.text
    response = client.get(base + f"/artifacts/{numbers['id']}/download", params={
        'expected_revision_id': state['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert response.status_code == 200 and response.content.endswith(b';0;1;1;\r\n')


@pytest.mark.parametrize('format_', ['csv', 'xlsx'])
def test_scientific_inn_exclusion_survives_intake_approval_and_separate_downloads(backend, tmp_path, format_):
    import csv
    from dataclasses import replace
    from io import BytesIO, StringIO
    from openpyxl import Workbook
    from app.main import create_app
    from processing_helpers import runtime

    seed(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=100_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    headers = ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS']
    good = ['123456789047', '001900', 'Тест', 'Test', '1', '0']
    bad = ['7,84201E+11', '002900', 'Ошибка', 'Error', '1', '0']
    if format_ == 'xlsx':
        book = Workbook()
        sheet = book.active
        sheet.append(headers)
        sheet.append([int(good[0]), *good[1:]])
        sheet['A2'].number_format = '0.00000E+00'
        sheet.append(bad)
        buffer = BytesIO()
        book.save(buffer)
        data = buffer.getvalue()
    else:
        data = ('\n'.join(';'.join(row) for row in [headers, good, bad]) + '\n').encode()
    received = client.post('/api/intakes', params={'partner': 'RTK HUB'},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': (f'source.{format_}', data)})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    case, revision = state['intake']['case_id'], state['revision']['id']
    base = f'/api/cases/{case}/revisions/{revision}'
    review = client.get(base + '/review').json()
    assert review['summary']['dispositions'] == {'included': 1, 'excluded_scientific_inn': 1}
    records = client.get(base + '/records').json()['items']
    assert records[1]['raw_cells'] == bad
    assert records[1]['disposition'] == 'excluded_scientific_inn'
    bundle = client.get(base + '/artifacts').json()
    approval = client.post(f'/api/cases/{case}/approval', json={'operation_id': str(uuid4()),
        'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
    assert approval.status_code == 200, approval.text
    expected = {'CLIENTS': [['', '', '', good[0]]], 'DOGTAGS': [[good[0], 'Тест', 'Test', '1']],
                'NUMBERS': [[good[0], 'Тест', '001900', '1', '0', '0', 'hubRTK']]}
    for artifact in bundle['artifacts']:
        if artifact['role'] not in expected:
            continue
        response = client.get(base + f"/artifacts/{artifact['id']}/download",
            params={'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
        assert response.status_code == 200, response.text
        rows = list(csv.reader(StringIO(response.content.decode('cp1251')), delimiter=';'))
        assert rows[1:] == expected[artifact['role']]
    source = state['revision']['source']['id']
    assert client.get(f'/api/cases/{case}/sources/{source}/raw').content == data


def test_upload_receipt_replay_ownership_and_automatic_build(backend, tmp_path):
    from processing_helpers import runtime
    seed(backend)
    client, key = backend.client(), uuid4()
    response = receive(client, key=key)
    assert response.status_code == 200, response.text
    result = response.json()['result']
    intake_id = result['intake']['id']
    assert receive(client, key=key).json()['id'] == response.json()['id']
    assert receive(client, key=key, data=DATA + b'\n').status_code == 409
    assert backend.client('other').get(f'/api/intakes/{intake_id}').status_code == 404
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['revision']['profile_snapshot']['INTERNAL_OPERATOR_NAME'] == 'hubRTK'
    assert len(client.get(f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}/artifacts").json()['artifacts']) == 4
    with backend.app.state.sessions() as db:
        assert len(db.scalars(select(Case)).all()) == 1
        assert len(db.scalars(select(Operation).where(Operation.action == 'intake.upload')).all()) == 1
        assert len(db.scalars(select(ProcessingRun)).all()) == 2


def test_missing_partner_decision_cas_and_automatic_continuation(backend, tmp_path):
    from processing_helpers import runtime
    seed(backend)
    client = backend.client()
    response = receive(client, partner=None)
    assert response.status_code == 200
    intake_id = response.json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        assert state['intake']['state'] == 'NEEDS_DECISION'
        assert 'partner' in {q['field'] for q in state['assessment']['questions']}
        body = {'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
                'decisions': {'partner': 'RTK MVNO'}}
        saved = client.post(f'/api/intakes/{intake_id}/decisions', json=body)
        assert saved.status_code == 200, saved.text
        assert client.post(f'/api/intakes/{intake_id}/decisions', json=body).json()['id'] == saved.json()['id']
        assert client.post(f'/api/intakes/{intake_id}/decisions', json={**body, 'operation_id': str(uuid4())}).status_code == 409
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['revision']['profile_snapshot']['INTERNAL_OPERATOR_NAME'] == ''
    with backend.app.state.sessions() as db:
        assert len(db.scalars(select(IntakeVersion)).all()) == 2


def test_intake_page_matches_details_with_bounded_queries(backend, tmp_path):
    from sqlalchemy import event
    from app.domain.intakes import detail, details
    from processing_helpers import runtime
    seed(backend)
    client = backend.client()
    ids = [UUID(receive(client, partner=None if index == 1 else 'RTK HUB')
                .json()['result']['intake']['id']) for index in range(5)]
    with runtime(backend, tmp_path) as settings:
        for intake_id in ids[1:]:
            drive(backend, settings, intake_id)
        drive(backend, settings, ids[2])
    with backend.app.state.sessions() as db:
        intakes = list(db.scalars(select(Intake).order_by(Intake.id)))
        expected = [detail(db, item) for item in intakes]
    with backend.app.state.sessions() as db:
        intakes = list(db.scalars(select(Intake).order_by(Intake.id)))
        statements = []
        connection = db.connection()
        def counted(_connection, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)
        event.listen(connection, 'before_cursor_execute', counted)
        try:
            assert details(db, intakes) == expected
        finally:
            event.remove(connection, 'before_cursor_execute', counted)
        # Related rows, work dates and actual output metadata: bounded independently of page size.
        assert len(statements) <= 3
    first = client.get('/api/intakes?limit=2').json()
    rest = client.get('/api/intakes', params={'after': first['next_cursor']}).json()
    ordered = sorted(expected, key=lambda item: (item['intake']['created_at'], item['intake']['id']), reverse=True)
    assert first['items'] + rest['items'] == [client.get(f"/api/intakes/{item['intake']['id']}").json()
                                             for item in ordered]
    assert backend.client('other').get('/api/intakes').json()['items'] == []


def test_real_queue_continues_after_browser_closes(backend, tmp_path):
    from app.processing.dispatcher import dispatch_once
    from processing_helpers import runtime, worker, wait_for
    seed(backend)
    client = backend.client()
    received = receive(client, data=DATA.removeprefix(b'\xef\xbb\xbf'))
    assert received.status_code == 200
    result = received.json()['result']
    case_id, intake_id = UUID(result['intake']['case_id']), result['intake']['id']
    client.close()
    def finished():
        with backend.app.state.sessions() as db:
            run = db.scalar(select(ProcessingRun).where(ProcessingRun.case_id == case_id, ProcessingRun.kind == 'BUILD'))
            return run if run and run.state in ('PREPARED', 'FAILED', 'BLOCKED') else None
    with runtime(backend, tmp_path) as settings, worker(backend, settings, tmp_path / 'worker'):
        def dispatch_and_check():
            dispatch_once(backend.app.state.sessions, settings)
            return finished()
        run = wait_for(dispatch_and_check)
        assert run.state == 'PREPARED', run.error
    restored = backend.client().get(f'/api/intakes/{intake_id}').json()
    assert restored['revision']['id'] == str(run.revision_id)


def test_mapping_questions_preview_and_one_cas_form(backend, tmp_path):
    from processing_helpers import runtime
    seed(backend)
    client = backend.client()
    data = ('\ufeffA;B;C;D;E;F;EXTRA\n7707083893;79000000000;Тест;Test;0;1;keep\n').encode()
    receipt = receive(client, data=data, partner=None).json()
    intake_id = receipt['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        assert {q['field'] for q in state['assessment']['questions']} == {'partner', 'mapping', 'operation'}
        preview = client.get(f'/api/intakes/{intake_id}/records')
        assert preview.status_code == 200 and preview.json()['items'][0]['cells'][-1] == 'keep'
        from dataclasses import replace
        backend.app.state.settings = replace(backend.settings, max_page_size=500)
        larger = client.get(f'/api/intakes/{intake_id}/records?limit=500')
        assert larger.status_code == 200 and len(larger.json()['items']) == 1
        assert larger.json()['next_cursor'] is None
        choices = {'partner': 'RTK ABC', 'operation': 'ADD', 'mapping': {
            'INN': 0, 'MSISDN': 1, 'MAV_LABEL_NAME': 2, 'MAV_LABEL_LATIN': 3, 'IS_MAV': 4, 'IS_KSS': 5}}
        body = {'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'], 'decisions': choices}
        assert client.post(f'/api/intakes/{intake_id}/decisions', json={**body, 'decisions': {
            **choices, 'context': {'verified': True}}}).status_code == 422
        assert client.post(f'/api/intakes/{intake_id}/decisions', json=body).status_code == 200
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['revision']['filename_components']['partner'] == 'RTK-ABC'
    assert client.get('/api/intakes').json()['items'][0]['intake']['id'] == intake_id
    assert backend.client('other').get('/api/intakes').json()['items'] == []
    recovered = client.get('/api/operations', params={'operation_id': receipt['operation_id'], 'action': 'intake.upload'})
    assert recovered.status_code == 200 and recovered.json()['result']['intake']['id'] == intake_id
    assert 'private_pending' not in recovered.text


def test_rules_setup_blocks_delete_until_rules_are_pinned(backend, tmp_path):
    from processing_helpers import runtime
    client = backend.client()
    intake_id = receive(client, data=b'MSISDN\r\n79000000000\r\n').json()['result']['intake']['id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        assert 'rules_setup_required' in {q['code'] for q in state['assessment']['questions']}
        assert state['assessment']['result']['operation'] == 'DELETE'
        assert state['revision'] is None
        seed(backend)
        response = client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'], 'decisions': {}})
        assert response.status_code == 200
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert 'rules_setup_required' not in {q['code'] for q in state['assessment']['questions']}
    assert state['revision']['settings']['operation'] == 'DELETE'


def test_xlsx_upload_is_read_by_content_and_damaged_workbook_stays_downloadable(backend, tmp_path):
    from dataclasses import replace
    from io import BytesIO
    import openpyxl
    from processing_helpers import runtime
    seed(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=100_000)
    from app.main import create_app
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS'])
    sheet.append(['7707083893', '79000000000', 'Тест', 'Test', '0', '1'])
    buffer = BytesIO()
    workbook.save(buffer)
    response = receive(client, data=buffer.getvalue())
    assert response.status_code == 200, response.text
    good = response.json()['result']
    bad = receive(client, data=b'PK\x03\x04broken').json()['result']
    with runtime(backend, tmp_path) as settings:
        for result in (good, bad):
            drive(backend, settings, result['intake']['id'])
            drive(backend, settings, result['intake']['id'])
    prepared = client.get(f"/api/intakes/{good['intake']['id']}").json()
    assert prepared['job']['state'] == 'PREPARED', prepared
    rejected = client.get(f"/api/intakes/{bad['intake']['id']}").json()
    assert rejected['intake']['state'] == 'NEEDS_DECISION' and rejected['revision'] is None
    assert client.get(f"/api/cases/{bad['intake']['case_id']}/sources/{bad['source']['id']}/raw").content == b'PK\x03\x04broken'


def test_five_independent_files_keep_successes_when_one_upload_fails(backend):
    seed(backend)
    client = backend.client()
    keys = [uuid4() for _ in range(5)]
    results = [receive(client, key=key, data=DATA if i != 2 else b'x' * 3000)
               for i, key in enumerate(keys)]
    assert [r.status_code for r in results] == [200, 200, 413, 200, 200]
    cases = [r.json()['result']['intake']['case_id'] for i, r in enumerate(results) if i != 2]
    assert len(set(cases)) == 4
    repaired = receive(client, key=keys[2])
    assert repaired.status_code == 200
    assert repaired.json()['result']['intake']['case_id'] not in cases
    assert len(client.get('/api/intakes').json()['items']) == 5


def test_published_status_header_alias_prevents_automatic_add(backend, tmp_path):
    from processing_helpers import runtime
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = [*user.permissions, 'rules.publish']
        config = seed_config()
        config['version'] = 'synthetic-status-alias'
        config['aliases']['STATUS'] = ['SyntheticResult']
        publish_rules(db, user, config, reason='Synthetic header alias test')
        db.commit()
    client = backend.client()
    lines = DATA.decode().splitlines()
    data = (lines[0] + ';SyntheticResult\n' + lines[1] + ';unknown\n').encode()
    initial = receive(client, data=data).json()['result']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, initial['intake']['id'])
    state = client.get(f"/api/intakes/{initial['intake']['id']}").json()
    assert state['assessment']['result']['operation'] == 'STATUS'
    assert state['revision'] is None
    assert 'return_correlation_required' in {q['code'] for q in state['assessment']['questions']}
