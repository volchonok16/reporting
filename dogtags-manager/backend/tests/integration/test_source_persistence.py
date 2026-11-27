"""Real PostgreSQL, API, and raw filesystem boundaries; fixtures contain synthetic values only."""
import hashlib
import json
from pathlib import Path
from uuid import UUID, uuid4

import anyio
import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, inspect, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.main import create_app
from app.models import AuditEvent, Case, ProcessingRevision, SourceAsset
from conftest import CSV_BYTES, ORIGIN, new_case, upload


def source_count(backend):
    with backend.app.state.sessions() as db:
        return db.scalar(select(func.count()).select_from(SourceAsset))


def test_saved_draft_reopens_with_identical_raw_hash_metadata_and_profile(backend):
    client = backend.client()
    case = new_case(client)
    first = upload(client, case)
    assert first.status_code == 200
    result = first.json()["result"]
    source, revision = result["source"], result["revision"]
    assert source["sha256"] == hashlib.sha256(CSV_BYTES).hexdigest()
    assert source["size_bytes"] == len(CSV_BYTES)
    assert source["inspection"]["records_count"] == 1
    assert source["inspection"]["errors"] == []
    assert revision["state"] == "DRAFT" and revision["correction_overlay"] == []
    assert revision["profile_snapshot"] == {"id": "hub-v1", "name": "RTK HUB", "SPREADING": "0",
                                             "INTERNAL_OPERATOR_NAME": "hubRTK"}
    assert client.get(f"/api/cases/{case}/sources/{source['id']}/raw").content == CSV_BYTES
    restarted = create_app(backend.settings, engine=backend.engine)
    reopened = TestClient(restarted, base_url=ORIGIN)
    reopened.cookies.update(client.cookies)
    saved = reopened.get(f"/api/cases/{case}")
    assert saved.status_code == 200
    assert saved.json()["head_revision_id"] == revision["id"]
    assert saved.json()["revision"] == revision
    assert saved.json()["external_state"] == "NOT_SUBMITTED"


def test_upload_replay_precedes_head_check_and_replacement_preserves_history(backend):
    client = backend.client()
    case = new_case(client)
    key = uuid4()
    first = upload(client, case, operation_id=key)
    assert first.status_code == 200
    initial = first.json()
    assert upload(client, case, operation_id=key).json() == initial
    assert upload(client, case, data=CSV_BYTES + b"changed", operation_id=key).status_code == 409
    assert upload(client, case, operation_id=key, encoding="cp1251").status_code == 409
    replacement = upload(client, case, data=CSV_BYTES.replace(b"Test", b"Other"),
                         expected=initial["result"]["revision"]["id"])
    assert replacement.status_code == 200
    revision = replacement.json()["result"]["revision"]
    assert revision["sequence"] == 2
    assert revision["parent_revision_id"] == initial["result"]["revision"]["id"]
    assert upload(client, case, operation_id=key).json() == initial
    assert upload(client, case).status_code == 409
    old_revision = client.get(f"/api/cases/{case}/revisions/{initial['result']['revision']['id']}")
    assert old_revision.json() == initial["result"]["revision"]
    old_raw = client.get(f"/api/cases/{case}/sources/{initial['result']['source']['id']}/raw")
    assert old_raw.content == CSV_BYTES
    assert source_count(backend) == 2


def test_same_bytes_and_client_key_in_new_case_are_legitimate(backend):
    client = backend.client()
    key = uuid4()
    cases = [new_case(client), new_case(client)]
    first, second = [upload(client, case, operation_id=key) for case in cases]
    assert first.status_code == second.status_code == 200
    one, two = first.json()["result"]["source"], second.json()["result"]["source"]
    assert one["id"] != two["id"] and one["sha256"] == two["sha256"]
    with backend.app.state.sessions() as db:
        sources = list(db.scalars(select(SourceAsset)))
        assert sources[0].storage_key == sources[1].storage_key
    assert len(list(backend.settings.storage_root.glob("objects/sha256/*/*"))) == 1
    mismatched = client.get(f"/api/cases/{cases[1]}/sources/{one['id']}")
    assert mismatched.status_code == 404
    for receipt, case in zip((first.json(), second.json()), cases, strict=True):
        response = client.get("/api/operations", params={"operation_id": str(key), "action": "source.upload",
                                                          "case_id": case})
        assert response.status_code == 200 and response.json() == receipt


def test_lost_case_create_response_is_recoverable_by_client_known_key(backend):
    client = backend.client()
    key = str(uuid4())
    original = client.post("/api/cases", json={"operation_id": key, "title": "Recovered"})
    recovered = client.get("/api/operations", params={"operation_id": key, "action": "case.create"})
    assert recovered.status_code == 200 and recovered.json() == original.json()
    assert client.get("/api/operations", params={"operation_id": key, "action": "source.upload"}).status_code == 404
    other = backend.client("other")
    assert other.get("/api/operations", params={"operation_id": key, "action": "case.create"}).status_code == 404


@pytest.mark.parametrize(("data", "encoding", "error_code", "count"), [
    (b"EXTERNAL;INN\r\nkeep;1.2E+09\r\n", "utf-8", "unsupported_schema", 1),
    (CSV_BYTES + b'"unterminated', "utf-8", "source_csv_syntax_error", None),
    (CSV_BYTES + b"\xff", "utf-8", "source_encoding_error", None),
])
def test_source_inspection_errors_preserve_raw_without_inference(backend, data, encoding, error_code, count):
    client = backend.client()
    case = new_case(client)
    response = upload(client, case, data=data, encoding=encoding)
    assert response.status_code == 200
    source = response.json()["result"]["source"]
    assert source["encoding"] == encoding
    assert source["inspection"]["records_count"] == count
    assert source["inspection"]["errors"][0]["code"] == error_code
    assert client.get(f"/api/cases/{case}/sources/{source['id']}/raw").content == data


def test_explicit_cp1251_and_unknown_encoding_no_fallback(backend):
    client = backend.client()
    case = new_case(client)
    data = CSV_BYTES.replace(b"Test;Test", "Тест;Test".encode("cp1251"))
    response = upload(client, case, data=data, encoding="cp1251")
    assert response.status_code == 200
    source = response.json()["result"]["source"]
    assert source["inspection"]["records_count"] == 1 and source["inspection"]["errors"] == []
    assert client.get(f"/api/cases/{case}/sources/{source['id']}/raw").content == data
    assert upload(client, new_case(client), data=data, encoding="auto").status_code == 422


def test_actual_file_cap_no_accessible_source(backend):
    client = backend.client()
    case = new_case(client)
    response = upload(client, case, data=b"x" * (backend.settings.max_upload_bytes + 1))
    assert response.status_code == 413 and response.json()["error"]["code"] == "file_too_large"
    assert source_count(backend) == 0
    assert client.get(f"/api/cases/{case}").json()["head_revision_id"] is None
    assert not list(backend.settings.storage_root.glob("objects/sha256/*/*"))


def streamed_upload(backend, client, case, data, *, content_length=None, disconnect=False):
    request = httpx.Request("POST", ORIGIN, files={"file": ("synthetic.csv", data, "text/csv")})
    body = request.read()
    headers = [(b"host", b"127.0.0.1:8000"), (b"content-type", request.headers["content-type"].encode()),
               (b"cookie", f"{backend.settings.cookie_name}={client.cookies[backend.settings.cookie_name]}".encode()),
               (b"origin", ORIGIN.encode()), (b"x-csrf-token", client.headers["x-csrf-token"].encode()),
               (b"x-operation-id", str(uuid4()).encode())]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "scheme": "http",
             "method": "POST", "path": f"/api/cases/{case}/sources", "raw_path": b"/",
             "query_string": b"encoding=utf-8", "headers": headers, "server": ("127.0.0.1", 8000),
             "client": ("127.0.0.1", 32100), "root_path": ""}
    events, consumed, offset = [], 0, 0

    async def receive():
        nonlocal offset, consumed
        if disconnect and offset >= len(body) // 2:
            return {"type": "http.disconnect"}
        chunk = body[offset:offset + 64]
        offset += len(chunk)
        consumed += len(chunk)
        return {"type": "http.request", "body": chunk, "more_body": offset < len(body)}

    async def send(message):
        events.append(message)

    async def execute():
        await backend.app(scope, receive, send)

    anyio.run(execute)
    start = next(event for event in events if event["type"] == "http.response.start")
    payload = b"".join(event.get("body", b"") for event in events if event["type"] == "http.response.body")
    return start["status"], json.loads(payload), consumed


@pytest.mark.parametrize("declared", [None, 1])
def test_body_cap_counted_before_spooling_without_or_with_false_length(backend, declared):
    client = backend.client()
    case = new_case(client)
    status, payload, consumed = streamed_upload(backend, client, case, b"x" * 10000, content_length=declared)
    assert status == 413 and payload["error"]["code"] == "request_too_large"
    assert consumed <= backend.settings.max_upload_bytes + backend.settings.multipart_overhead_bytes + 64
    assert source_count(backend) == 0
    assert not list(backend.settings.storage_root.glob("objects/sha256/*/*"))


def test_legitimate_chunked_upload_and_length_mismatch_and_disconnect(backend):
    client = backend.client()
    case = new_case(client)
    status, payload, _ = streamed_upload(backend, client, case, CSV_BYTES)
    assert status == 200 and payload["status"] == "SUCCEEDED"
    case = new_case(client)
    status, payload, _ = streamed_upload(backend, client, case, CSV_BYTES, content_length=1)
    assert status == 400 and payload["error"]["code"] == "body_length_mismatch"
    status, payload, _ = streamed_upload(backend, client, case, CSV_BYTES, disconnect=True)
    assert status == 400 and payload["error"]["code"] == "incomplete_upload"
    assert client.get(f"/api/cases/{case}").json()["head_revision_id"] is None
    assert source_count(backend) == 1


def test_storage_creation_failure_is_persisted_and_readable(backend):
    client = backend.client()
    case, key = new_case(client), uuid4()
    backend.settings.storage_root.write_bytes(b"synthetic obstruction")
    response = upload(client, case, operation_id=key)
    assert response.status_code == 503
    receipt = client.get("/api/operations", params={"operation_id": str(key), "case_id": case,
                                                   "action": "source.upload"})
    assert receipt.status_code == 200
    assert receipt.json()["status"] == "FAILED" and receipt.json()["error"]["retryable"] is True
    assert source_count(backend) == 0
    assert upload(client, case, operation_id=key).status_code == 503
    assert upload(client, case, operation_id=key, data=CSV_BYTES + b"changed").status_code == 409


def test_close_failure_still_persists_storage_operation_error(backend, monkeypatch):
    client = backend.client()
    case, key = new_case(client), uuid4()
    original_open = Path.open

    class CloseFailure:
        def __init__(self, stream):
            self.stream = stream

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def close(self):
            self.stream.close()
            raise OSError("synthetic close failure")

    def open_with_close_failure(path, *args, **kwargs):
        stream = original_open(path, *args, **kwargs)
        return CloseFailure(stream) if ".staging" in path.parts and args and args[0] == "xb" else stream

    monkeypatch.setattr(Path, "open", open_with_close_failure)
    response = upload(client, case, operation_id=key)
    assert response.status_code == 503
    recovered = client.get("/api/operations", params={"operation_id": str(key), "case_id": case,
                                                     "action": "source.upload"})
    assert recovered.json()["status"] == "FAILED" and recovered.json()["error"]["retryable"]
    assert source_count(backend) == 0


def test_raw_published_before_failed_db_commit_has_no_accessible_source(backend):
    client = backend.client()
    case, key = new_case(client), uuid4()
    with backend.engine.begin() as connection:
        connection.execute(text("""CREATE FUNCTION fail_source_insert() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'synthetic transaction interruption'; END; $$"""))
        connection.execute(text("CREATE TRIGGER test_interrupt_source BEFORE INSERT ON source_assets "
                                "FOR EACH ROW EXECUTE FUNCTION fail_source_insert()"))
    response = upload(client, case, operation_id=key)
    assert response.status_code == 503 and response.json()["error"]["code"] == "database_unavailable"
    assert "synthetic transaction interruption" not in response.text
    assert len(list(backend.settings.storage_root.glob("objects/sha256/*/*"))) == 1
    assert source_count(backend) == 0
    assert client.get(f"/api/cases/{case}").json()["head_revision_id"] is None
    recovered = client.get("/api/operations", params={"operation_id": str(key), "case_id": case,
                                                     "action": "source.upload"})
    assert recovered.json()["status"] == "RUNNING" and recovered.json()["result"] is None
    assert upload(client, case, operation_id=key).status_code == 202
    with backend.engine.begin() as connection:
        connection.execute(text("DROP TRIGGER test_interrupt_source ON source_assets"))
        connection.execute(text("DROP FUNCTION fail_source_insert()"))
    assert upload(client, case).status_code == 200
    assert source_count(backend) == 1


def test_existing_hash_is_verified_and_never_overwritten(backend):
    client = backend.client()
    one, two = new_case(client), new_case(client)
    first = upload(client, one)
    assert first.status_code == 200
    with backend.app.state.sessions() as db:
        source = db.get(SourceAsset, UUID(first.json()["result"]["source"]["id"]))
    object_path = backend.settings.storage_root / source.storage_key
    object_path.write_bytes(b"synthetic corruption")
    failed = upload(client, two)
    assert failed.status_code == 503
    assert object_path.read_bytes() == b"synthetic corruption"
    assert source_count(backend) == 1
    assert client.get(f"/api/cases/{one}/sources/{source.id}/raw").status_code == 503


def test_migration_names_scope_constraints_and_immutability(backend):
    client = backend.client()
    case = new_case(client)
    result = upload(client, case).json()["result"]
    other = new_case(client)
    inspector = inspect(backend.engine)
    assert set(inspector.get_table_names()) >= {"cases", "source_assets", "processing_revisions", "operations",
                                               "sessions", "artifact_sets", "approvals", "outbox", "audit_events"}
    for table in inspector.get_table_names():
        for foreign_key in inspector.get_foreign_keys(table):
            assert foreign_key["name"].startswith("fk_")
    with backend.engine.connect() as connection:
        for statement, parameters in (
            ("UPDATE source_assets SET encoding='cp1251' WHERE id=:id", {"id": UUID(result["source"]["id"])}),
            ("DELETE FROM processing_revisions WHERE id=:id", {"id": UUID(result["revision"]["id"])}),
            ("UPDATE cases SET head_revision_id=:revision WHERE id=:id",
             {"id": UUID(other), "revision": UUID(result["revision"]["id"])}),
            ("DELETE FROM audit_events WHERE case_id=:id", {"id": UUID(case)}),
        ):
            with pytest.raises(SQLAlchemyError):
                connection.execute(text(statement), parameters)
            connection.rollback()
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 1
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == 3
        assert db.get(Case, UUID(other)).head_revision_id is None
    configuration = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
    with backend.engine.begin() as connection:
        configuration.attributes["connection"] = connection
        command.upgrade(configuration, "head")
    assert source_count(backend) == 1


def test_openapi_persists_typed_cross_unit_surface(backend):
    schemas = backend.app.openapi()["components"]["schemas"]
    for name in ("SessionState", "CaseState", "SourceState", "RevisionState", "OperationState", "ErrorEnvelope"):
        assert schemas[name]["type"] == "object"
    assert schemas["OperationState"]["properties"]["operation_id"]["format"] == "uuid"
    assert schemas["SourceState"]["properties"]["encoding"]["enum"] == ["utf-8", "cp1251"]
