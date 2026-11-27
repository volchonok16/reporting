"""Local workspace access has no credential step; mutations retain CSRF checks."""
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import create_app
from app.models import Case, Session, User, utcnow
from conftest import ORIGIN


def local_app(backend):
    return create_app(replace(backend.settings, local_access=True), engine=backend.engine)


def test_no_credentials_shared_workspace_and_existing_history(backend):
    with backend.app.state.sessions() as db:
        owner = db.scalar(select(User).where(User.username == 'operator'))
        existing = Case(owner_id=owner.id, title='Existing synthetic history')
        db.add(existing)
        db.commit()
        case_id, owner_id = str(existing.id), str(owner.id)
    app = local_app(backend)
    assert '/api/session/login' not in app.openapi()['paths']
    assert '/api/session/logout' not in app.openapi()['paths']
    first, second = TestClient(app, base_url=ORIGIN), TestClient(app, base_url=ORIGIN)
    assert first.get('/api/cases').status_code == 200
    for client in (first, second):
        state = client.get('/api/session').json()
        assert state['authenticated'] and state['user']['id'] == owner_id
        assert state['csrf_token']
        assert any(row['id'] == case_id for row in client.get('/api/cases').json()['items'])
        assert client.post('/api/session/login', json={}).status_code in (404, 405)
        assert client.post('/api/session/logout', json={}).status_code in (404, 405)
    command = {'title': 'No credential upload workspace', 'operation_id': str(uuid4())}
    assert first.post('/api/cases', json=command).status_code == 403
    state = first.get('/api/session').json()
    headers = {'Origin': ORIGIN, 'X-CSRF-Token': state['csrf_token']}
    assert first.post('/api/cases', json=command, headers=headers).status_code == 200
    assert first.post('/api/cases', json={**command, 'operation_id': str(uuid4())},
                      headers={**headers, 'Origin': 'https://unrelated.invalid'}).status_code == 403


def test_expired_technical_session_renews_without_login(backend):
    app = local_app(backend)
    client = TestClient(app, base_url=ORIGIN)
    old = client.get('/api/session').json()
    with app.state.sessions() as db:
        session = db.scalar(select(Session).where(Session.csrf_token == old['csrf_token']))
        session.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    response = client.get('/api/session')
    assert response.status_code == 200
    assert response.json()['user']['id'] == old['user']['id']
    assert response.json()['csrf_token'] != old['csrf_token']


def test_empty_installation_gets_one_persistent_workspace(backend):
    app = local_app(backend)
    with app.state.sessions() as db:
        for user in db.scalars(select(User)):
            user.active = False
        db.commit()
    first = TestClient(app, base_url=ORIGIN).get('/api/session').json()
    second = TestClient(app, base_url=ORIGIN).get('/api/session').json()
    assert first['authenticated'] and first['user']['id'] == second['user']['id']
    assert {'case.read', 'case.edit', 'package.approve', 'rules.publish'} <= set(first['user']['permissions'])


def test_workspace_retains_the_existing_operators_permissions(backend):
    app = local_app(backend)
    with app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = ['case.read']
        db.commit()
    client = TestClient(app, base_url=ORIGIN)
    state = client.get('/api/session').json()
    assert state['user']['permissions'] == ['case.read']
    assert client.get('/api/cases').status_code == 200
    assert client.post('/api/cases', json={'title': 'Not allowed', 'operation_id': str(uuid4())},
                       headers={'Origin': ORIGIN, 'X-CSRF-Token': state['csrf_token']}).status_code == 403
