"""Scoped immutable download and observed ASGI response evidence."""
import asyncio
import hashlib
import io
import json
import zipfile
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from starlette.requests import ClientDisconnect
from starlette.responses import StreamingResponse

from app.api.downloads import ObservedDownload
from app.main import create_app
from app.middleware import IngressMiddleware
from app.models import Approval, Artifact, AuditEvent, ProcessingRun, User
from app.processing.dispatcher import dispatch_once
from app.settings import Settings
from conftest import new_case
from processing_helpers import launch_job, read_run, runtime, wait_for, worker
from test_approval_races import approval_body, prepared, save_body
from test_artifact_publication import link_for_read_proof, publish


def test_response_disconnect_is_not_an_incomplete_request_upload(tmp_path):
    async def scenario():
        first_body = asyncio.Event()
        sent = []

        async def content():
            yield b"first"
            await asyncio.Event().wait()

        async def app(scope, receive, send):
            await StreamingResponse(content())(scope, receive, send)

        async def receive():
            await first_body.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body":
                first_body.set()

        scope = {"type": "http", "method": "GET", "scheme": "http", "headers": [(b"host", b"127.0.0.1")],
                 "asgi": {"version": "3.0", "spec_version": "2.3"}}
        middleware = IngressMiddleware(app, Settings(database_url="postgresql+psycopg://unused", storage_root=tmp_path))
        await middleware(scope, receive, send)
        assert sent[0]["status"] == 200
        assert sent[1]["body"] == b"first" and sent[1]["more_body"]

    asyncio.run(scenario())


def test_csv_response_declares_actual_windows_1251_encoding(tmp_path):
    path = tmp_path / "synthetic.csv"
    data = "Тест\r\n".encode("cp1251")
    path.write_bytes(data)
    artifact = Artifact(role="CLIENTS", size_bytes=len(data), download_filename="synthetic.csv")
    with path.open("rb") as stream:
        response = ObservedDownload(stream, artifact, None, {}, uuid4(), uuid4(), uuid4())
        assert response.headers["content-type"] == "text/csv; charset=windows-1251"


def download_url(case, revision, artifact_id):
    return f"/api/cases/{case}/revisions/{revision}/artifacts/{artifact_id}/download"


def params(revision, manifest_hash):
    return {"expected_revision_id": revision, "manifest_hash": manifest_hash}


def approve_and_files(client, case, revision, manifest_hash):
    response = client.post(f"/api/cases/{case}/approval", json=approval_body(revision, manifest_hash))
    assert response.status_code == 200
    files = client.get(f"/api/cases/{case}/revisions/{revision}/artifacts").json()["artifacts"]
    return response.json()["result"]["approval"], files


def events(backend, action):
    with backend.app.state.sessions() as db:
        return db.scalars(select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.created_at)).all()


def test_all_csv_and_zip_download_exact_approved_bytes_and_observed_completion(backend, tmp_path):
    client, case, _, revision, _, bundle = prepared(backend, tmp_path)
    decision, files = approve_and_files(client, case, revision, bundle.manifest_hash)
    for file, obj in zip(files, bundle.artifacts, strict=True):
        response = client.get(download_url(case, revision, file["id"]), params=params(revision, bundle.manifest_hash))
        assert response.status_code == 200
        assert response.content == backend.app.state.storage.path_for_key(obj.storage_key).read_bytes()
        assert hashlib.sha256(response.content).hexdigest() == obj.sha256
        assert response.headers["content-length"] == str(obj.size_bytes)
        assert response.headers["content-disposition"] == f'attachment; filename="{obj.download_filename}"'
        assert "storage_key" not in response.headers
        assert response.headers["content-type"] == ("application/zip" if obj.role == "ZIP"
                                                   else "text/csv; charset=windows-1251")
        if obj.role == "ZIP":
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                assert archive.namelist() == [item.download_filename for item in bundle.artifacts[:3]]
                for item in bundle.artifacts[:3]:
                    assert archive.read(item.download_filename) == backend.app.state.storage.path_for_key(
                        item.storage_key).read_bytes()
    attempts = events(backend, "download.attempted")
    completed = events(backend, "download.response_completed")
    assert len(attempts) == len(completed) == 4
    for attempt, completion in zip(attempts, completed, strict=True):
        assert completion.details["attempt_id"] == attempt.details["attempt_id"]
        assert completion.details["approval_id"] == decision["id"]
        assert completion.details["bytes_sent"] == attempt.details["size_bytes"]
        assert completion.details["evidence"] == "asgi_final_body_accepted"
    assert client.get(f"/api/cases/{case}").json()["external_state"] == "NOT_SUBMITTED"


def test_unapproved_foreign_and_permission_denied_downloads_never_admitted(backend, tmp_path):
    client, case, _, revision, _, bundle = prepared(backend, tmp_path)
    files = client.get(f"/api/cases/{case}/revisions/{revision}/artifacts").json()["artifacts"]
    artifact_id = files[0]["id"]
    path = download_url(case, revision, artifact_id)
    query = params(revision, bundle.manifest_hash)
    response = client.get(path, params=query)
    assert response.status_code == 409 and response.json()["error"]["code"] == "package_not_approved"
    approve_and_files(client, case, revision, bundle.manifest_hash)
    assert backend.client("other").get(path, params=query).status_code == 404
    another_case = new_case(client)
    assert client.get(download_url(another_case, revision, artifact_id), params=query).status_code == 404
    assert client.get(download_url(case, revision, uuid4()), params=query).status_code == 404
    with backend.app.state.sessions() as db:
        operator = db.scalar(select(User).where(User.username == "operator"))
        operator.permissions = [value for value in operator.permissions if value != "package.approve"]
        db.commit()
    assert client.get(path, params=query).status_code == 403
    assert not events(backend, "download.attempted")


def test_asset_from_other_revision_cannot_be_substituted(backend, tmp_path):
    client, case, source, first, _, first_bundle = prepared(backend, tmp_path)
    _, first_files = approve_and_files(client, case, first, first_bundle.manifest_hash)
    saved = client.post(f"/api/cases/{case}/revisions", json=save_body(source, first))
    second = saved.json()["result"]["revision"]["id"]
    bundle = publish(backend, source, second, tmp_path / "second")
    link_for_read_proof(backend, second, bundle)
    with backend.app.state.sessions() as db:
        run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == UUID(second)))
        run.summary = json.loads((tmp_path / "second/dataset/summary.json").read_text())
        db.commit()
    approve_and_files(client, case, second, bundle.manifest_hash)
    response = client.get(download_url(case, second, first_files[0]["id"]), params=params(second, bundle.manifest_hash))
    assert response.status_code == 404
    assert not events(backend, "download.attempted")


@pytest.mark.parametrize("fault", ["wrong_hash", "wrong_expected", "changed_head", "missing_other_csv"])
def test_download_rechecks_current_exact_set_and_full_integrity_before_response(backend, tmp_path, fault):
    client, case, source, revision, _, bundle = prepared(backend, tmp_path)
    _, files = approve_and_files(client, case, revision, bundle.manifest_hash)
    query = params(revision, bundle.manifest_hash)
    if fault == "wrong_hash":
        query["manifest_hash"] = "0" * 64
    elif fault == "wrong_expected":
        query["expected_revision_id"] = str(uuid4())
    elif fault == "changed_head":
        assert client.post(f"/api/cases/{case}/revisions", json=save_body(source, revision)).status_code == 200
    else:
        backend.app.state.storage.path_for_key(bundle.artifacts[1].storage_key).unlink()
    response = client.get(download_url(case, revision, files[0]["id"]), params=query)
    assert response.status_code == (503 if fault == "missing_other_csv" else 409)
    assert not events(backend, "download.attempted")


def asgi_download(backend, client, case, revision, artifact_id, manifest_hash, *, after_admission=None,
                  interrupt=False, spec="2.3"):
    async def scenario():
        sent, first_request, disconnected = [], True, asyncio.Event()
        query = f"expected_revision_id={revision}&manifest_hash={manifest_hash}".encode()
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": spec}, "http_version": "1.1",
                 "scheme": "http", "method": "GET", "path": download_url(case, revision, artifact_id),
                 "raw_path": b"/", "query_string": query, "headers": [(b"host", b"127.0.0.1:8000"),
                 (b"cookie", f"{backend.settings.cookie_name}={client.cookies[backend.settings.cookie_name]}".encode())],
                 "server": ("127.0.0.1", 8000), "client": ("127.0.0.1", 32100), "root_path": ""}

        async def receive():
            nonlocal first_request
            if first_request:
                first_request = False
                return {"type": "http.request", "body": b"", "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start" and after_admission:
                await asyncio.to_thread(after_admission)
            if interrupt and message["type"] == "http.response.body" and not message.get("more_body", False):
                if spec == "2.4":
                    raise OSError("Synthetic closed client connection")
                disconnected.set()
                await asyncio.Event().wait()  # Listener cancels response before the final body is accepted.
            sent.append(message)

        try:
            await backend.app(scope, receive, send)
        except ClientDisconnect:
            assert interrupt and spec == "2.4"
        return sent

    return asyncio.run(scenario())


def test_edit_after_admission_keeps_old_exact_bytes_without_approving_new_head(backend, tmp_path):
    client, case, source, revision, _, bundle = prepared(backend, tmp_path)
    _, files = approve_and_files(client, case, revision, bundle.manifest_hash)
    saved = []

    def change_head():
        response = client.post(f"/api/cases/{case}/revisions", json=save_body(source, revision))
        assert response.status_code == 200
        saved.append(response.json()["result"]["revision"]["id"])

    sent = asgi_download(backend, client, case, revision, files[0]["id"], bundle.manifest_hash,
                         after_admission=change_head)
    assert sent[0]["status"] == 200
    actual = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    assert actual == backend.app.state.storage.path_for_key(bundle.artifacts[0].storage_key).read_bytes()
    assert len(events(backend, "download.response_completed")) == 1
    new = client.get(f"/api/cases/{case}/revisions/{saved[0]}/approval").json()
    assert new["current"] and not new["approved"] and new["approval"] is None
    assert client.get(download_url(case, revision, files[0]["id"]),
                      params=params(revision, bundle.manifest_hash)).status_code == 409


@pytest.mark.parametrize("spec", ["2.3", "2.4"])
def test_interrupted_response_has_attempt_only_and_retry_needs_no_new_approval(backend, tmp_path, spec):
    client, case, _, revision, _, bundle = prepared(backend, tmp_path)
    _, files = approve_and_files(client, case, revision, bundle.manifest_hash)
    sent = asgi_download(backend, client, case, revision, files[0]["id"], bundle.manifest_hash,
                         interrupt=True, spec=spec)
    assert sent[0]["status"] == 200
    assert len(events(backend, "download.attempted")) == 1
    assert not events(backend, "download.response_completed")
    retry = client.get(download_url(case, revision, files[0]["id"]), params=params(revision, bundle.manifest_hash))
    assert retry.status_code == 200 and hashlib.sha256(retry.content).hexdigest() == files[0]["sha256"]
    assert len(events(backend, "download.attempted")) == 2
    completed = events(backend, "download.response_completed")
    assert len(completed) == 1 and completed[0].details["bytes_sent"] == files[0]["size_bytes"]
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Approval)) == 1
    assert client.get(f"/api/cases/{case}").json()["external_state"] == "NOT_SUBMITTED"


def test_latest_download_evidence_does_not_reuse_previous_completion_and_is_scoped(backend, tmp_path):
    client, case, _, revision, _, bundle = prepared(backend, tmp_path)
    _, files = approve_and_files(client, case, revision, bundle.manifest_hash)
    artifact = files[0]
    evidence_path = download_url(case, revision, artifact["id"]) + "-evidence"
    assert client.get(evidence_path).json()["latest_attempt"] is None
    assert client.get(download_url(case, revision, artifact["id"]),
                      params=params(revision, bundle.manifest_hash)).status_code == 200
    completed = client.get(evidence_path).json()["latest_attempt"]
    assert completed["response_completed_at"] and completed["bytes_sent"] == artifact["size_bytes"]
    asgi_download(backend, client, case, revision, artifact["id"], bundle.manifest_hash, interrupt=True)
    aborted = client.get(evidence_path).json()["latest_attempt"]
    assert aborted["attempt_id"] != completed["attempt_id"]
    assert aborted["response_completed_at"] is None and aborted["bytes_sent"] is None
    assert aborted["sha256"] == artifact["sha256"] and aborted["manifest_hash"] == bundle.manifest_hash
    assert backend.client("other").get(evidence_path).status_code == 404
    other_case = new_case(client)
    assert client.get(download_url(other_case, revision, artifact["id"]) + "-evidence").status_code == 404
    backend.app = create_app(backend.settings, engine=backend.engine)
    assert backend.client().get(evidence_path).json()["latest_attempt"] == aborted


def test_real_worker_prepares_then_approval_and_download_survive_api_recreation(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, _, revision, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path / "worker"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        result = client.get(f"/api/cases/{case}/revisions/{revision}/artifacts").json()
        decision, files = approve_and_files(client, case, revision, result["manifest_hash"])
        original = client.get(download_url(case, revision, files[3]["id"]),
                              params=params(revision, result["manifest_hash"]))
        assert original.status_code == 200
        # A fresh API instance and session must read the same persisted decision and bytes.
        backend.app = create_app(backend.settings, engine=backend.engine)
        reopened = backend.client()
        state = reopened.get(f"/api/cases/{case}/revisions/{revision}/approval").json()
        assert state["approved"] and state["approval"] == decision
        download = reopened.get(download_url(case, revision, files[3]["id"]),
                                params=params(revision, result["manifest_hash"]))
        assert download.status_code == 200 and download.content == original.content
        assert hashlib.sha256(download.content).hexdigest() == files[3]["sha256"]
        assert reopened.get(f"/api/cases/{case}").json()["external_state"] == "NOT_SUBMITTED"
