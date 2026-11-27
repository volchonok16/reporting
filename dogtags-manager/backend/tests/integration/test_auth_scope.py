from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth.accounts import create_account, token_digest
from app.auth.policy import require_permission
from app.models import Case, Session, User, utcnow
from app.settings import Settings
from app.errors import ApiError
from conftest import ORIGIN, PASSWORD, new_case, upload


def test_prelogin_csrf_challenge_uses_persisted_session(backend):
    client = TestClient(backend.app, base_url=ORIGIN)
    response = client.get("/api/session")
    assert response.status_code == 200
    assert response.json()["authenticated"] is False
    assert response.json()["csrf_token"]
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Secure" not in cookie
    with backend.app.state.sessions() as db:
        session = db.scalar(select(Session))
        assert session.token_digest == token_digest(client.cookies[backend.settings.cookie_name])
        assert session.csrf_token == response.json()["csrf_token"]
        assert db.connection().exec_driver_sql("SELECT current_schema()").scalar_one() == backend.schema


def test_wrong_password_and_login_origin_csrf_do_not_authenticate(backend):
    client = TestClient(backend.app, base_url=ORIGIN)
    challenge = client.get("/api/session").json()
    body = {"username": "operator", "password": "wrong synthetic password"}
    headers = {"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"]}
    assert client.post("/api/session/login", json=body, headers=headers).status_code == 401
    assert client.post("/api/session/login", json={**body, "password": PASSWORD},
                       headers={"Origin": ORIGIN}).status_code == 403
    assert client.post("/api/session/login", json={**body, "password": PASSWORD},
                       headers={**headers, "Origin": "http://attacker.invalid"}).status_code == 403
    assert client.get("/api/cases").status_code == 401
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Session).where(Session.user_id.is_not(None))) == 0
        assert db.scalar(select(User).where(User.username == "operator")).password_hash.startswith("$argon2id$")


@pytest.mark.parametrize("revoked", [False, True])
def test_expired_or_revoked_session_denied_and_relogin_recovers(backend, revoked):
    client = backend.client()
    token = client.cookies[backend.settings.cookie_name]
    with backend.app.state.sessions() as db:
        session = db.scalar(select(Session).where(Session.token_digest == token_digest(token)))
        if revoked:
            session.revoked_at = utcnow()
        else:
            session.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    denied = client.get("/api/cases")
    assert denied.status_code == 401
    assert "Max-Age=0" in denied.headers["set-cookie"]
    challenge = client.get("/api/session")
    assert challenge.status_code == 200 and not challenge.json()["authenticated"]
    response = client.post("/api/session/login", json={"username": "operator", "password": PASSWORD},
                           headers={"Origin": ORIGIN, "X-CSRF-Token": challenge.json()["csrf_token"]})
    assert response.status_code == 200
    assert client.get("/api/cases").status_code == 200
    assert client.cookies[backend.settings.cookie_name] != token


def test_logout_revokes_token_in_postgres(backend):
    client = backend.client()
    token = client.cookies[backend.settings.cookie_name]
    assert client.post("/api/session/logout").status_code == 200
    with backend.app.state.sessions() as db:
        assert db.scalar(select(Session).where(Session.token_digest == token_digest(token))).revoked_at
    response = client.get("/api/cases", headers={"Cookie": f"{backend.settings.cookie_name}={token}"})
    assert response.status_code == 401


def test_mutation_csrf_origin_and_foreign_ids(backend):
    first, other = backend.client(), backend.client("other")
    case = new_case(first)
    source = upload(first, case).json()
    other_case = new_case(other)
    for path in (f"/api/cases/{case}", f"/api/cases/{case}/sources/{source['result']['source']['id']}",
                 f"/api/cases/{other_case}/sources/{source['result']['source']['id']}",
                 f"/api/cases/{case}/revisions/{source['result']['revision']['id']}",
                 f"/api/operations/{source['id']}",
                 f"/api/cases/{case}/sources/{source['result']['source']['id']}/raw"):
        response = other.get(path)
        assert response.status_code == 404
        assert "Synthetic HUB" not in response.text and "synthetic.csv" not in response.text
    assert upload(other, case).status_code == 404
    assert first.post("/api/cases", json={"operation_id": str(uuid4())},
                      headers={"X-CSRF-Token": "bad"}).status_code == 403
    assert first.post("/api/cases", json={"operation_id": str(uuid4())},
                      headers={"Origin": "http://attacker.invalid"}).status_code == 403
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Case)) == 2


def test_server_permissions_are_rechecked(backend):
    client = backend.client()
    case = new_case(client)
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == "operator"))
        user.permissions = ["case.read"]
        db.commit()
        for name in ("case.edit", "profile.override", "package.approve"):
            with pytest.raises(ApiError) as denied:
                require_permission(user, name)
            assert denied.value.status == 403
    assert client.get(f"/api/cases/{case}").status_code == 200
    assert upload(client, case).status_code == 403
    assert client.post("/api/cases", json={"operation_id": str(uuid4())}).status_code == 403
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == "operator"))
        user.permissions = []
        db.commit()
    assert client.get(f"/api/cases/{case}").status_code == 403


def test_secure_https_cookie_and_explicit_development_origin(backend):
    client = TestClient(backend.app, base_url="https://example.invalid")
    assert "Secure" in client.get("/api/session").headers["set-cookie"]
    remote = TestClient(backend.app, base_url="http://example.invalid")
    assert remote.get("/api/session").status_code == 403
    client = TestClient(backend.app, base_url=ORIGIN)
    csrf = client.get("/api/session").json()["csrf_token"]
    response = client.post("/api/session/login", json={"username": "operator", "password": PASSWORD},
                           headers={"Origin": "http://127.0.0.1:5173", "X-CSRF-Token": csrf})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    denied = client.options("/api/cases", headers={"Origin": "http://attacker.invalid",
                                                  "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in denied.headers
    with pytest.raises(ValueError):
        Settings(database_url=backend.settings.database_url, origins=("http://example.invalid",))


def test_validation_error_does_not_echo_credentials(backend):
    client = backend.client()
    response = client.post("/api/session/login", json={"username": "operator", "password": "secret-synthetic",
                                                       "unexpected": "private-value"})
    assert response.status_code == 422
    assert "private-value" not in response.text and "secret-synthetic" not in response.text
    assert UUID(response.json()["trace_id"])


def test_case_operation_replay_and_changed_body_conflict(backend):
    client = backend.client()
    key = str(uuid4())
    body = {"operation_id": key, "title": "First"}
    first = client.post("/api/cases", json=body)
    assert first.status_code == 200
    assert client.post("/api/cases", json=body).json() == first.json()
    assert client.post("/api/cases", json={**body, "title": "Other"}).status_code == 409
    other = backend.client("other")
    assert other.post("/api/cases", json=body).status_code == 200


def test_bootstrap_does_not_store_password_the_login_contract_rejects(backend):
    with backend.app.state.sessions() as db:
        with pytest.raises(ValueError):
            create_account(db, "too-long-password", "a" * 1025)
        assert db.scalar(select(func.count()).select_from(User).where(User.username == "too-long-password")) == 0
        create_account(db, "maximum-password", "a" * 1024)
        db.commit()
    client = TestClient(backend.app, base_url=ORIGIN)
    csrf = client.get("/api/session").json()["csrf_token"]
    response = client.post("/api/session/login", json={"username": "maximum-password", "password": "a" * 1024},
                           headers={"Origin": ORIGIN, "X-CSRF-Token": csrf})
    assert response.status_code == 200 and response.json()["authenticated"]
