from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from uuid import uuid4

from sqlalchemy import func, select

from app.models import AuditEvent, ProcessingMnemonic, RulePublication
from processing_helpers import runtime
from test_automatic_intake import seed, drive, receive


def settings(client):
    response = client.get('/api/processing-settings')
    assert response.status_code == 200, response.text
    return response.json()


def mnemonic(client, state, code='newHub', **kwargs):
    body = {'operation_id': str(uuid4()), 'expected_token': state['token'], 'action': 'add',
            'code': code, 'description': 'Новая мнемоника', **kwargs}
    return client.post('/api/dictionary/mnemonics', json=body), body


def test_dictionary_reads_existing_profiles_and_checks_authority_and_csrf(backend):
    seed(backend)
    client, other = backend.client(), backend.client('other')
    state = settings(client)
    assert state['can_manage'] and state['rules_ready']
    assert {item['code'] for item in state['mnemonics']} == {'hubRTK', 'fRTK'}
    assert not settings(other)['can_manage']
    assert settings(other)['profiles'] == state['profiles']
    response, body = mnemonic(other, state)
    assert response.status_code == 403
    client.headers.pop('X-CSRF-Token')
    assert client.post('/api/dictionary/mnemonics', json=body).status_code == 403


def test_mnemonic_crud_replay_duplicates_and_usage_guard(backend):
    seed(backend)
    client = backend.client()
    state = settings(client)
    response, body = mnemonic(client, state)
    assert response.status_code == 200, response.text
    added = response.json()
    assert client.post('/api/dictionary/mnemonics', json=body).json() == added
    assert client.post('/api/dictionary/mnemonics', json={**body, 'code': 'other'}).status_code == 409
    duplicate, _ = mnemonic(client, added)
    assert duplicate.status_code == 409 and duplicate.json()['error']['code'] == 'mnemonic_exists'
    used = next(item for item in added['mnemonics'] if item['code'] == 'hubRTK')
    for action, details in [('delete', {}), ('edit', {'code': 'renamed'})]:
        guarded = client.post('/api/dictionary/mnemonics', json={
            'operation_id': str(uuid4()), 'expected_token': added['token'],
            'action': action, 'mnemonic_id': used['id'], **details})
        assert guarded.status_code == 409 and guarded.json()['error']['code'] == 'mnemonic_in_use'
    edited = client.post('/api/dictionary/mnemonics', json={
        'operation_id': str(uuid4()), 'expected_token': added['token'], 'action': 'edit',
        'mnemonic_id': used['id'], 'code': used['code'], 'description': 'Описание для оператора'})
    assert edited.status_code == 200, edited.text
    item = next(item for item in added['mnemonics'] if item['code'] == 'newHub')
    removed = client.post('/api/dictionary/mnemonics', json={
        'operation_id': str(uuid4()), 'expected_token': edited.json()['token'],
        'action': 'delete', 'mnemonic_id': item['id']})
    assert removed.status_code == 200, removed.text
    assert 'newHub' not in {i['code'] for i in removed.json()['mnemonics']}
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action.like('dictionary.%'))) == 3


def test_stale_settings_and_unsupported_codes_cannot_be_published(backend):
    seed(backend)
    client = backend.client()
    original = settings(client)
    added, _ = mnemonic(client, original)
    assert added.status_code == 200
    stale, _ = mnemonic(client, original, code='another')
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'settings_changed'
    profiles = deepcopy(added.json()['profiles'])
    profiles['RTK HUB']['INTERNAL_OPERATOR_NAME'] = 'notInDictionary'
    invalid = client.post('/api/processing-settings/partners', json={
        'operation_id': str(uuid4()), 'expected_token': added.json()['token'], 'profiles': profiles})
    assert invalid.status_code == 422
    for code in ['😀', '\n', 'a\tb']:
        assert mnemonic(client, added.json(), code=code)[0].status_code == 422
    assert settings(client)['profiles'] == original['profiles']


def test_concurrent_repeat_creates_one_mnemonic_and_one_receipt(backend):
    seed(backend)
    clients = [backend.client(), backend.client()]
    state = settings(clients[0])
    body = {'operation_id': str(uuid4()), 'expected_token': state['token'],
            'action': 'add', 'code': 'repeatHub', 'description': ''}
    with ThreadPoolExecutor(max_workers=2) as workers:
        responses = list(workers.map(lambda client: client.post('/api/dictionary/mnemonics', json=body), clients))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProcessingMnemonic).where(ProcessingMnemonic.code == 'repeatHub')) == 1
        assert db.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == 'dictionary.mnemonic.add')) == 1


def test_partner_settings_change_new_uploads_but_preserve_prepared_kits(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as configuration:
        intake = receive(client).json()['result']['intake']['id']
        drive(backend, configuration, intake)
        drive(backend, configuration, intake)
        old = client.get('/api/intakes/' + intake).json()
        old_base = f"/api/cases/{old['intake']['case_id']}/revisions/{old['revision']['id']}"
        old_bundle = client.get(old_base + '/artifacts').json()
        state = settings(client)
        added, _ = mnemonic(client, state)
        assert added.status_code == 200, added.text
        profiles = deepcopy(added.json()['profiles'])
        profiles['RTK HUB'] = {'INTERNAL_OPERATOR_NAME': 'newHub', 'SPREADING': '1'}
        body = {'operation_id': str(uuid4()), 'expected_token': added.json()['token'], 'profiles': profiles}
        saved = client.post('/api/processing-settings/partners', json=body)
        assert saved.status_code == 200, saved.text
        assert client.post('/api/processing-settings/partners', json=body).json() == saved.json()
        assert next(i for i in saved.json()['mnemonics'] if i['code'] == 'newHub')['used_by'] == ['RTK HUB']
        assert client.get(old_base + '/artifacts').json()['manifest_hash'] == old_bundle['manifest_hash']
        assert client.get('/api/intakes/' + intake).json()['revision']['profile_snapshot']['INTERNAL_OPERATOR_NAME'] == 'hubRTK'
        newer = receive(client).json()['result']['intake']['id']
        drive(backend, configuration, newer)
        drive(backend, configuration, newer)
    current = client.get('/api/intakes/' + newer).json()
    assert current['job']['state'] == 'PREPARED', current
    base = f"/api/cases/{current['intake']['case_id']}/revisions/{current['revision']['id']}"
    bundle = client.get(base + '/artifacts').json()
    artifact = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
    preview = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
    assert preview['items'][0][-2:] == ['1', 'newHub']
    approval = client.post(f"/api/cases/{current['intake']['case_id']}/approval", json={
        'operation_id': str(uuid4()), 'expected_revision_id': current['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert approval.status_code == 200, approval.text
    download = client.get(base + f"/artifacts/{artifact['id']}/download", params={
        'expected_revision_id': current['revision']['id'], 'manifest_hash': bundle['manifest_hash']})
    assert download.status_code == 200 and ';1;newHub\r\n' in download.content.decode('cp1251')
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(RulePublication)) == 2


def test_dictionary_can_initialize_missing_rule_publication(backend):
    from app.models import User
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = [*user.permissions, 'rules.publish']
        db.commit()
    client = backend.client()
    state = settings(client)
    assert not state['rules_ready']
    response = client.post('/api/processing-settings/partners', json={
        'operation_id': str(uuid4()), 'expected_token': state['token'], 'profiles': state['profiles']})
    assert response.status_code == 200, response.text
    assert response.json()['rules_ready']


def test_shared_mnemonic_has_a_stable_token_after_database_reload(backend):
    seed(backend)
    client = backend.client()
    state = settings(client)
    profiles = {partner: {'INTERNAL_OPERATOR_NAME': 'hubRTK', 'SPREADING': '0'}
                for partner in ['RTK MVNO', 'RTK HUB', 'RTK ABC', 'ГПБМ']}
    response = client.post('/api/processing-settings/partners', json={
        'operation_id': str(uuid4()), 'expected_token': state['token'], 'profiles': profiles})
    assert response.status_code == 200, response.text
    assert response.json()['token'] == settings(client)['token']
    assert next(i for i in response.json()['mnemonics'] if i['code'] == 'hubRTK')['used_by'] == ['RTK ABC', 'RTK HUB', 'RTK MVNO', 'ГПБМ']


def test_empty_partner_operator_is_saved_without_a_catalogue_placeholder(backend):
    seed(backend)
    client = backend.client()
    state = settings(client)
    profiles = deepcopy(state['profiles'])
    profiles['RTK HUB']['INTERNAL_OPERATOR_NAME'] = ''
    response = client.post('/api/processing-settings/partners', json={
        'operation_id': str(uuid4()), 'expected_token': state['token'], 'profiles': profiles})
    assert response.status_code == 200, response.text
    assert settings(client)['profiles']['RTK HUB']['INTERNAL_OPERATOR_NAME'] == ''
    assert '' not in {item['code'] for item in settings(client)['mnemonics']}
    rejected, _ = mnemonic(client, settings(client), code='none')
    assert rejected.status_code == 422


def test_custom_partner_flags_reach_verified_output_and_latin_is_only_a_warning(backend, tmp_path):
    seed(backend)
    client = backend.client()
    state = settings(client)
    partner = 'Новый партнёр'
    profile = {'INTERNAL_OPERATOR_NAME': '', 'SPREADING': '1', 'IS_MAV': '0', 'IS_KSS': '1'}
    response = client.post('/api/processing-settings/partners', json={
        'operation_id': str(uuid4()), 'expected_token': state['token'],
        'profiles': {**state['profiles'], partner: profile}})
    assert response.status_code == 200, response.text
    assert settings(client)['profiles'][partner] == profile

    data = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n'
            '7707083893;79000000000;Тест Brand;Test Brand;1;0\r\n').encode('utf-8-sig')
    with runtime(backend, tmp_path) as configuration:
        response = receive(client, partner=partner, data=data)
        assert response.status_code == 200, response.text
        intake = response.json()['result']['intake']['id']
        drive(backend, configuration, intake)
        drive(backend, configuration, intake)
    current = client.get('/api/intakes/' + intake).json()
    assert current['job']['state'] == 'PREPARED', current
    revision = current['revision']
    base = f"/api/cases/{revision['case_id']}/revisions/{revision['id']}"
    bundle = client.get(base + '/artifacts').json()
    artifact = next(item for item in bundle['artifacts'] if item['role'] == 'NUMBERS')
    preview = client.get(base + f"/artifacts/{artifact['id']}/preview").json()
    assert preview['items'] == [['7707083893', 'Тест Brand', '79000000000', '0', '1', '1', '']]
    assert 'label_contains_latin' not in client.get(base + '/review').json()['summary']['issue_counts']
    record = client.get(base + '/records').json()['items'][0]
    assert not record['issue_fields']
    assert [(item['code'], item['scope']) for item in record['issues']] == [('label_contains_latin', 'warning')]
