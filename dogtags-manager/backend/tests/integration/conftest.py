"""A unique synthetic schema per test; never migrate or delete the public schema."""
import os
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.auth.accounts import create_account
from app.db import make_engine
from app.main import create_app
from app.settings import Settings

ORIGIN = "http://127.0.0.1:8000"
PASSWORD = "Synthetic test password 42"


@dataclass
class Backend:
    app: object
    engine: object
    settings: Settings
    schema: str

    def client(self, username="operator"):
        client = TestClient(self.app, base_url=ORIGIN)
        challenge = client.get("/api/session")
        assert challenge.status_code == 200
        login = client.post("/api/session/login", json={"username": username, "password": PASSWORD},
                            headers={"Origin": ORIGIN, "X-CSRF-Token": challenge.json()["csrf_token"]})
        assert login.status_code == 200
        client.headers.update({"Origin": ORIGIN, "X-CSRF-Token": login.json()["csrf_token"]})
        return client


@pytest.fixture
def backend(tmp_path):
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Integration proof requires an explicit TEST_DATABASE_URL for PostgreSQL.")
    schema = "test_" + uuid4().hex
    admin = make_engine(url)
    try:
        with admin.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    except SQLAlchemyError:
        raise pytest.fail.Exception("The isolated PostgreSQL fixture could not connect.", pytrace=False) from None
    engine = make_engine(url, connect_args={"options": f"-c search_path={schema}"})
    try:
        with engine.begin() as connection:
            assert connection.execute(text("SELECT current_schema()")).scalar_one() == schema
            configuration = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
            configuration.attributes["connection"] = connection
            command.upgrade(configuration, "head")
        settings = Settings(database_url=url, storage_root=tmp_path / "storage",
                            local_access=False,
                            origins=(ORIGIN, "http://127.0.0.1:5173"), max_upload_bytes=1024,
                            multipart_overhead_bytes=1024)
        app = create_app(settings, engine=engine)
        with app.state.sessions() as db:
            create_account(db, "operator", PASSWORD)
            create_account(db, "other", PASSWORD)
            db.commit()
        yield Backend(app, engine, settings, schema)
    except SQLAlchemyError:
        raise pytest.fail.Exception("PostgreSQL integration failed; connection details and parameters are suppressed.",
                                    pytrace=False) from None
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def new_case(client, title="Synthetic HUB", operation_id=None):
    response = client.post("/api/cases", json={"title": title, "operation_id": str(operation_id or uuid4())})
    assert response.status_code == 200
    return response.json()["result"]["case"]["id"]


CSV_BYTES = (b"INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n"
             b"1234567890;9000000000;Test;Test;1;0\r\n")


def upload(client, case_id, data=CSV_BYTES, operation_id=None, expected=None, encoding="utf-8",
           filename="synthetic.csv"):
    params = {"encoding": encoding}
    if expected:
        params["expected_revision_id"] = expected
    return client.post(f"/api/cases/{case_id}/sources", params=params,
                       headers={"X-Operation-ID": str(operation_id or uuid4())},
                       files={"file": (filename, data, "text/csv")})
