from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.models import AuditEvent
from processing_helpers import runtime
from test_automatic_intake import drive
from test_whitemav import prepare


def test_saved_choices_persist_and_duplicate_add_is_idempotent(backend):
    client = backend.client()
    assert client.get('/api/whitemav/inns').json()['items'] == ['7743895280', '7707083893']
    body = {'inn': '7805406976'}
    first = client.post('/api/whitemav/inns', json=body)
    assert first.status_code == 200, first.text
    assert first.json()['items'] == ['7743895280', '7707083893', '7805406976']
    assert client.post('/api/whitemav/inns', json=body).json() == first.json()
    assert backend.client().get('/api/whitemav/inns').json() == first.json()
    assert backend.client('other').get('/api/whitemav/inns').json()['items'] == ['7743895280', '7707083893']
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == 'whitemav.inn.add')) == 1


def test_company_names_persist_and_are_shared_with_upload_choices(backend):
    client = backend.client()
    first = client.post('/api/whitemav/inns', json={'inn': '7805406976', 'company_name': 'ООО Пример'})
    assert first.status_code == 200, first.text
    assert {'inn': '7805406976', 'company_name': 'ООО Пример'} in first.json()['entries']
    renamed = client.put('/api/whitemav/inns/7805406976', json={'company_name': 'ООО Новое имя'})
    assert renamed.status_code == 200, renamed.text
    assert {'inn': '7805406976', 'company_name': 'ООО Новое имя'} in backend.client().get('/api/whitemav/inns').json()['entries']
    assert '7805406976' not in backend.client('other').get('/api/whitemav/inns').json()['items']
    assert client.post('/api/whitemav/inns', json={'inn': '7805406976'}).json() == renamed.json()
    default = client.put('/api/whitemav/inns/7707083893', json={'company_name': 'Тестовая компания'})
    assert default.status_code == 200, default.text
    assert {'inn': '7707083893', 'company_name': 'Тестовая компания'} in default.json()['entries']
    assert {'inn': '7707083893', 'company_name': ''} in backend.client('other').get('/api/whitemav/inns').json()['entries']
    assert client.put('/api/whitemav/inns/7820000000', json={'company_name': 'Не добавлена'}).status_code == 422


@pytest.mark.parametrize('inn', ['7743895280', '7707083893', '7805406976'])
def test_delete_is_persistent_scoped_and_can_be_added_again(backend, inn):
    client = backend.client()
    assert client.post('/api/whitemav/inns', json={'inn': inn, 'company_name': 'Компания'}).status_code == 200
    other = backend.client('other')
    assert other.post('/api/whitemav/inns', json={'inn': inn, 'company_name': 'Другой аккаунт'}).status_code == 200
    deleted = client.delete('/api/whitemav/inns/' + inn)
    assert deleted.status_code == 200, deleted.text
    assert inn not in deleted.json()['items']
    assert client.delete('/api/whitemav/inns/' + inn).json() == deleted.json()
    assert inn not in backend.client().get('/api/whitemav/inns').json()['items']
    assert inn in other.get('/api/whitemav/inns').json()['items']
    rejected = client.post('/api/intakes', params={'operation': 'WHITEMAV', 'whitemav_inn': inn},
        headers={'X-Operation-ID': str(uuid4())}, files={'file': ('numbers.csv', b'MSISDN\n79937967877\n')})
    assert rejected.status_code == 422
    restored = client.post('/api/whitemav/inns', json={'inn': inn, 'company_name': 'Новое название'})
    assert {'inn': inn, 'company_name': 'Новое название'} in restored.json()['entries']
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.action == 'whitemav.inn.delete')) == 1


@pytest.mark.parametrize('inn', ['123', '7707083894', '７７０７０８３８９３', '7,84201E+11'])
def test_invalid_inn_cannot_be_saved(backend, inn):
    client = backend.client()
    assert client.post('/api/whitemav/inns', json={'inn': inn}).status_code == 422
    assert client.get('/api/whitemav/inns').json()['items'] == ['7743895280', '7707083893']


def test_custom_inn_is_pinned_through_revisions_and_can_be_changed_explicitly(backend, tmp_path):
    client = backend.client()
    assert client.post('/api/whitemav/inns', json={'inn': '7805406976', 'company_name': 'ООО Пример'}).status_code == 200
    client, intake_id, state, base, _ = prepare(backend, tmp_path, 'csv', [['', '79937967877']], inn='7805406976')
    assert state['revision']['settings']['whitemav_inn'] == '7805406976'
    bundle = client.get(base + '/artifacts').json()
    number = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
    row = client.get(base + f"/artifacts/{number['id']}/preview").json()['items'][0]
    assert row[0] == '7805406976'
    assert 'ООО Пример' not in row
    assert client.delete('/api/whitemav/inns/7805406976').status_code == 200
    saved = client.post(f"/api/cases/{state['intake']['case_id']}/processing/save-and-start", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'], 'source_asset_id': state['source']['id']})
    assert saved.status_code == 200, saved.text
    with runtime(backend, tmp_path / 'saved') as settings:
        drive(backend, settings, intake_id)
    current = client.get('/api/intakes/' + intake_id).json()
    assert current['revision']['settings']['whitemav_inn'] == '7805406976'
    unchanged = client.post(f'/api/intakes/{intake_id}/decisions', json={
        'operation_id': str(uuid4()), 'expected_version_id': current['version']['id'],
        'decisions': {'whitemav_inn': '7805406976'}})
    assert unchanged.status_code == 200, unchanged.text
    current = client.get('/api/intakes/' + intake_id).json()
    changed = client.post(f'/api/intakes/{intake_id}/decisions', json={
        'operation_id': str(uuid4()), 'expected_version_id': current['version']['id'],
        'decisions': {'whitemav_inn': '7707083893'}})
    assert changed.status_code == 200, changed.text
    with runtime(backend, tmp_path / 'changed') as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    final = client.get('/api/intakes/' + intake_id).json()
    assert final['job']['state'] == 'PREPARED', final
    assert final['revision']['settings']['whitemav_inn'] == '7707083893'
    assert client.get(base + f"/artifacts/{number['id']}/preview").json()['items'][0][0] == '7805406976'


def test_unknown_choice_and_wrong_process_are_rejected(backend):
    client = backend.client()
    for operation, inn in [('WHITEMAV', '7805406976'), ('ADD', '7707083893')]:
        response = client.post('/api/intakes', params={'operation': operation, 'whitemav_inn': inn},
            headers={'X-Operation-ID': str(uuid4())}, files={'file': ('numbers.csv', b'MSISDN\n79937967877\n')})
        assert response.status_code == 422


def test_catalogue_requires_edit_permission_and_csrf(backend):
    from app.auth.accounts import create_account
    from conftest import PASSWORD
    with backend.app.state.sessions() as db:
        create_account(db, 'reader', PASSWORD, permissions=('case.read',))
        db.commit()
    reader = backend.client('reader')
    assert reader.get('/api/whitemav/inns').status_code == 200
    assert reader.post('/api/whitemav/inns', json={'inn': '7805406976'}).status_code == 403
    assert backend.client().post('/api/whitemav/inns', json={'inn': '7805406976'},
                                 headers={'X-CSRF-Token': 'incorrect'}).status_code == 403
    assert reader.put('/api/whitemav/inns/7707083893', json={'company_name': 'Компания'}).status_code == 403
    assert backend.client().put('/api/whitemav/inns/7707083893', json={'company_name': 'Компания'},
                               headers={'X-CSRF-Token': 'incorrect'}).status_code == 403
    assert reader.delete('/api/whitemav/inns/7707083893').status_code == 403
    assert backend.client().delete('/api/whitemav/inns/7707083893', headers={'X-CSRF-Token': 'incorrect'}).status_code == 403


def test_selected_inn_is_part_of_upload_idempotency(backend):
    client, key = backend.client(), str(uuid4())
    def upload(inn):
        return client.post('/api/intakes', params={'operation': 'WHITEMAV', 'whitemav_inn': inn},
            headers={'X-Operation-ID': key}, files={'file': ('numbers.csv', b'MSISDN\n79937967877\n')})
    first = upload('7707083893')
    assert first.status_code == 200, first.text
    assert upload('7707083893').json()['result']['intake']['id'] == first.json()['result']['intake']['id']
    assert upload('7743895280').status_code == 409


def test_downgrade_cannot_erase_saved_inns(backend):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    client = backend.client()
    assert client.post('/api/whitemav/inns', json={'inn': '7805406976'}).status_code == 200
    with pytest.raises(RuntimeError, match='Saved WhiteMAV'), backend.engine.begin() as connection:
        config = Config(str(Path(__file__).resolve().parents[2] / 'alembic.ini'))
        config.attributes['connection'] = connection
        command.downgrade(config, '0011')
    assert '7805406976' in client.get('/api/whitemav/inns').json()['items']


def test_company_name_migration_preserves_old_entries_and_refuses_loss(backend):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    from sqlalchemy import text
    config = Config(str(Path(__file__).resolve().parents[2] / 'alembic.ini'))
    with backend.engine.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, '0012')
        owner = connection.scalar(text("SELECT id FROM users WHERE username='operator'"))
        identity = uuid4()
        connection.execute(text('INSERT INTO whitemav_inns (id,created_at,owner_id,inn) VALUES (:id,now(),:owner,:inn)'),
                           {'id': identity, 'owner': owner, 'inn': '7805406976'})
        before = connection.execute(text('SELECT id,created_at,owner_id,inn FROM whitemav_inns ORDER BY created_at,id')).all()
        command.upgrade(config, 'head')
        assert connection.execute(text('SELECT id,created_at,owner_id,inn FROM whitemav_inns ORDER BY created_at,id')).all() == before
        assert connection.scalar(text('SELECT company_name FROM whitemav_inns')) == ''
    client = backend.client()
    assert client.put('/api/whitemav/inns/7805406976', json={'company_name': 'ООО Пример'}).status_code == 200
    with pytest.raises(RuntimeError, match='Saved company names'), backend.engine.begin() as connection:
        config.attributes['connection'] = connection
        command.downgrade(config, '0012')
    assert {'inn': '7805406976', 'company_name': 'ООО Пример'} in client.get('/api/whitemav/inns').json()['entries']


def test_downgrade_cannot_restore_deleted_defaults(backend):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    client = backend.client()
    assert client.delete('/api/whitemav/inns/7743895280').status_code == 200
    with pytest.raises(RuntimeError, match='would reappear'), backend.engine.begin() as connection:
        config = Config(str(Path(__file__).resolve().parents[2] / 'alembic.ini'))
        config.attributes['connection'] = connection
        command.downgrade(config, '0013')
    assert '7743895280' not in client.get('/api/whitemav/inns').json()['items']
