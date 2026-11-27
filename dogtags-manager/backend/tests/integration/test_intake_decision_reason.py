from uuid import uuid4

from test_automatic_intake import receive, seed


def test_older_intake_can_select_new_gpbm_without_changing_old_snapshot(backend, tmp_path):
    from uuid import UUID
    from sqlalchemy import select
    from app.domain.rules import rules_snapshot, seed_config, profile_for
    from app.models import IntakeVersion, RulePublication, SourceProfileVersion, User
    from processing_helpers import runtime
    from test_automatic_intake import drive
    config = seed_config()
    del config['profiles']['ГПБМ']
    config['version'] = 'frozen-three-partners'
    old_snapshot = rules_snapshot(config)
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        db.add(RulePublication(version=config['version'], digest=old_snapshot['digest'],
            snapshot=old_snapshot, created_by=user.id, reason='Frozen legacy intake fixture'))
        for partner in config['profiles']:
            db.add(SourceProfileVersion(version=f"rules:{old_snapshot['digest']}:{partner}",
                config_hash=old_snapshot['digest'], snapshot=profile_for(old_snapshot, partner)))
        db.commit()
    client = backend.client()
    initial = receive(client).json()['result']
    intake_id = initial['intake']['id']
    old_id = UUID(initial['version']['id'])
    seed(backend)
    response = client.post('/api/intakes/' + intake_id + '/decisions', json={
        'operation_id': str(uuid4()), 'expected_version_id': str(old_id),
        'decisions': {'partner': 'ГПБМ', 'reason': 'Уточнён партнёр'}})
    assert response.status_code == 200, response.text
    with runtime(backend, tmp_path) as configuration:
        drive(backend, configuration, intake_id)
        drive(backend, configuration, intake_id)
    state = client.get('/api/intakes/' + intake_id).json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['revision']['profile_snapshot']['partner'] == 'ГПБМ'
    with backend.app.state.sessions() as db:
        assert db.get(IntakeVersion, old_id).decisions['rules_snapshot'] == old_snapshot


def test_partner_change_requires_its_own_recorded_reason(backend):
    seed(backend)
    client = backend.client()
    initial = receive(client).json()['result']
    path = f"/api/intakes/{initial['intake']['id']}"
    body = {'operation_id': str(uuid4()), 'expected_version_id': initial['version']['id'],
            'decisions': {'partner': 'RTK ABC'}}
    rejected = client.post(path + '/decisions', json=body)
    assert rejected.status_code == 422
    assert rejected.json()['error']['code'] == 'partner_change_reason_required'
    assert client.get(path).json()['version']['id'] == initial['version']['id']
    body['decisions']['reason'] = 'Уточнён отправитель заявки'
    saved = client.post(path + '/decisions', json=body)
    assert saved.status_code == 200
    state = client.get(path).json()
    assert state['version']['decisions']['reason'] == 'Уточнён отправитель заявки'
    assert state['version']['decisions']['partner'] == 'RTK ABC'
    assert client.post(path + '/decisions', json=body).json()['id'] == saved.json()['id']
    next_body = {'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
                 'decisions': {'partner': 'RTK MVNO'}}
    # A reason from the previous version cannot silently authorize the next change.
    assert client.post(path + '/decisions', json=next_body).status_code == 422


def test_partner_change_preserves_saved_record_corrections(backend, tmp_path):
    from processing_helpers import runtime
    from test_automatic_intake import drive
    seed(backend)
    client = backend.client()
    initial = receive(client).json()['result']
    intake_id = initial['intake']['id']
    path = f'/api/intakes/{intake_id}'
    case = initial['intake']['case_id']
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(path).json()
        revision = state['revision']
        record = client.get(f"/api/cases/{case}/revisions/{revision['id']}/records").json()['items'][0]
        saved = client.post(f'/api/cases/{case}/revisions', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revision['id'],
            'source_asset_id': revision['source']['id'], 'overrides': [], 'corrections': [{
                'record_id': record['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_NAME',
                'before': 'Тест', 'after': 'Тест Новый', 'reason': 'Уточнение маркировки'}]})
        assert saved.status_code == 200, saved.text
        changed = client.post(path + '/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'partner': 'RTK MVNO', 'reason': 'Уточнение отправителя'}})
        assert changed.status_code == 200, changed.text
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
        state = client.get(path).json()
        assert state['job']['state'] == 'PREPARED', state
        assert state['revision']['profile_snapshot']['INTERNAL_OPERATOR_NAME'] == ''
        rows = client.get(f"/api/cases/{case}/revisions/{state['revision']['id']}/records").json()['items']
        assert rows[0]['effective']['MAV_LABEL_NAME'] == 'Тест Новый'
        assert state['revision']['correction_overlay'] == saved.json()['result']['revision']['correction_overlay']
        mapping = dict(state['assessment']['result']['mapping'])
        mapping['MAV_LABEL_NAME'], mapping['MAV_LABEL_LATIN'] = mapping['MAV_LABEL_LATIN'], mapping['MAV_LABEL_NAME']
        changed = client.post(path + '/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'mapping': mapping}})
        assert changed.status_code == 200, changed.text
        drive(backend, settings, intake_id)
        blocked = client.get(path).json()
        assert blocked['intake']['state'] == 'NEEDS_DECISION'
        assert blocked['revision'] is None
        assert 'saved_corrections_mapping_conflict' in {q['code'] for q in blocked['assessment']['questions']}
