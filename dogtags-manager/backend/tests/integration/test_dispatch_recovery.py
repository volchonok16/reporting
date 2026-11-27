import time
from dataclasses import replace
from uuid import UUID, uuid4

import pytest

from sqlalchemy import func, select

from app.models import ArtifactSet, AuditEvent, Outbox, ProcessingRevision, ProcessingRun
from app.processing.dispatcher import confirm, dispatch_once, publish_job, reserve
from app.processing.leases import claim
from app.processing.recovery import sweep
from app.processing.tasks import make_celery
from conftest import new_case, upload
from processing_helpers import SOURCE, kill_worker, launch_job, read_run, runtime, wait_for, worker


def test_start_draft_is_atomic_and_replays_original_receipt(backend):
    client = backend.client()
    case_id = new_case(client)
    revision_id = upload(client, case_id).json()["result"]["revision"]["id"]
    body = {"operation_id": str(uuid4()), "expected_revision_id": revision_id}
    response = client.post(f"/api/cases/{case_id}/processing/start", json=body)
    assert response.status_code == 200
    receipt = response.json()
    assert receipt["result"]["job"]["state"] == "QUEUED"
    assert client.post(f"/api/cases/{case_id}/processing/start", json=body).json() == receipt
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 1
        assert db.scalar(select(func.count()).select_from(ProcessingRun)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
    revision = client.get(f"/api/cases/{case_id}/revisions/{revision_id}").json()
    newer = client.post(f"/api/cases/{case_id}/revisions", json={"operation_id": str(uuid4()),
                       "expected_revision_id": revision_id, "source_asset_id": revision["source"]["id"]})
    assert newer.status_code == 200
    assert client.post(f"/api/cases/{case_id}/processing/start", json=body).json() == receipt
    assert client.post(f"/api/cases/{case_id}/processing/start", json={**body,
                       "expected_revision_id": newer.json()["result"]["revision"]["id"]}).status_code == 409


def test_save_and_start_creates_one_revision_job_outbox_and_scopes_receipt(backend):
    client = backend.client()
    case = new_case(client)
    result = upload(client, case, data=SOURCE).json()["result"]
    revision = result["revision"]["id"]
    body = {"operation_id": str(uuid4()), "expected_revision_id": revision,
            "source_asset_id": result["source"]["id"], "corrections": [], "overrides": []}
    path = f"/api/cases/{case}/processing/save-and-start"
    response = client.post(path, json=body)
    assert response.status_code == 200
    saved = response.json()
    assert saved["result"]["revision"]["sequence"] == 2
    assert saved["result"]["job"]["revision_id"] == saved["result"]["revision"]["id"]
    assert client.post(path, json=body).json() == saved
    assert client.post(path, json={**body, "expected_revision_id": saved["result"]["revision"]["id"]}).status_code == 409
    assert backend.client("other").get(
        f"/api/cases/{case}/processing/{saved['result']['job']['id']}").status_code == 404
    assert client.post(f"/api/cases/{case}/processing/start", json={"operation_id": str(uuid4()),
                      "expected_revision_id": revision}).status_code == 409
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 2
        assert db.scalar(select(func.count()).select_from(ProcessingRun)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_broker_outage_after_commit_recovers_without_second_revision(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, _, revision, run_id = launch_job(backend)
        unavailable = replace(settings, broker_url="amqp://127.0.0.1:1//")
        assert dispatch_once(backend.app.state.sessions, unavailable) is False
        state = client.get(f"/api/cases/{case}/processing/{run_id}").json()
        assert state["state"] == "QUEUED" and state["attempt"] == 0
        time.sleep(0.12)
        with worker(backend, settings, tmp_path):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        assert client.get(f"/api/cases/{case}").json()["head_revision_id"] == revision
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 1


def test_duplicate_real_deliveries_publish_one_set_and_completion_event(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, run_id = launch_job(backend)
        app = make_celery(settings)
        publish_job(app, run_id)
        publish_job(app, run_id)
        with worker(backend, settings, tmp_path):
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
            time.sleep(0.3)
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 1
            assert db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "processing.completed")) == 1
            assert db.get(ProcessingRun, run_id).attempt == 1


@pytest.mark.parametrize("checkpoint", ["after_claim", "after_file_staging", "after_bundle_publication",
                                       "after_finalization"])
def test_real_worker_crash_windows_recover_without_duplicate_publication(backend, tmp_path, checkpoint):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path, fault=checkpoint) as process:
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: (tmp_path / "checkpoint").exists())
            kill_worker(process)
        if checkpoint != "after_finalization":
            time.sleep(settings.lease_seconds + 0.1)
            assert sweep(backend.app.state.sessions, settings) == 1
            time.sleep(settings.retry_backoff_seconds + 0.05)
        with worker(backend, settings, tmp_path):
            if checkpoint != "after_finalization":
                dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
            time.sleep(0.3)
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 1
            assert db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "processing.completed")) == 1
        assert read_run(backend, run_id).attempt == (1 if checkpoint == "after_finalization" else 2)


def test_delayed_confirm_cannot_mark_reset_outbox_sent(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, run_id = launch_job(backend)
        reservation = reserve(backend.app.state.sessions, settings)
        lease = claim(backend.app.state.sessions, run_id, settings)
        assert lease is not None
        time.sleep(settings.lease_seconds + 0.1)
        sweep(backend.app.state.sessions, settings)
        assert confirm(backend.app.state.sessions, reservation, settings, published=True) is False
        with backend.app.state.sessions() as db:
            outbox = db.scalar(select(Outbox).where(Outbox.run_id == run_id))
            assert outbox.published_at is None and outbox.attempts > reservation[3]
        time.sleep(settings.retry_backoff_seconds + 0.05)
        with worker(backend, settings, tmp_path):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")


def test_resource_ceiling_and_manual_technical_retry_preserve_revision_history(backend, tmp_path):
    with runtime(backend, tmp_path, scratch_min_free_bytes=2**70) as settings:
        client, case, _, revision, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path):
            for attempt in range(1, settings.max_job_attempts + 1):
                wait_for(lambda: dispatch_once(backend.app.state.sessions, settings))
                wait_for(lambda: read_run(backend, run_id).attempt == attempt
                         and read_run(backend, run_id).state != "PROCESSING")
        saved = read_run(backend, run_id)
        assert saved.state == "FAILED" and saved.error["code"] == "scratch_space_exhausted"
        assert saved.error["retryable"] is True
        body = {"operation_id": str(uuid4()), "expected_revision_id": revision}
        path = f"/api/cases/{case}/processing/retry"
        response = client.post(path, json=body)
        assert response.status_code == 200
        receipt = response.json()
        assert receipt["result"]["job"]["id"] == str(run_id)
        with worker(backend, replace(settings, scratch_min_free_bytes=0), tmp_path):
            wait_for(lambda: dispatch_once(backend.app.state.sessions, settings))
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        assert client.post(path, json=body).json() == receipt
        assert client.post(path, json={**body, "expected_revision_id": str(uuid4())}).status_code == 409
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 1
            assert db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "processing.failed")) == 3
            assert db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "processing.retry_requested")) == 1


@pytest.mark.parametrize("kind", ["scientific", "empty", "bad_shape", "unknown_remainder"])
def test_data_blocker_finishes_review_without_transient_retries(backend, tmp_path, kind):
    with runtime(backend, tmp_path) as settings:
        bad = {"scientific": SOURCE.replace(b"1234567894", b"7,84201E+11"),
               "empty": SOURCE.split(b"\r\n")[0] + b"\r\n",
               "bad_shape": SOURCE.replace(b";1;1\r\n", b";1\r\n"),
               "unknown_remainder": SOURCE + b'"unterminated'}[kind]
        client, case, source, revision, run_id = launch_job(backend, bad)
        expected_state = 'PREPARED' if kind == 'scientific' else 'BLOCKED'
        with worker(backend, settings, tmp_path):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == expected_state)
        saved = read_run(backend, run_id)
        assert saved.attempt == 1
        if kind == "scientific":
            assert saved.summary["issue_counts"]["inn_scientific"] == 2
        elif kind == "empty":
            assert any(item["code"] == "source_empty" for item in saved.summary["file_errors"])
        elif kind == "bad_shape":
            assert saved.summary["issue_counts"]["row_shape"] == 1
        else:
            assert saved.summary["unknown_remainder"] is True and saved.summary["records_count"] is None
        review = client.get(f"/api/cases/{case}/revisions/{revision}/review").json()
        assert review['dataset_available']
        assert review['summary']['blocking'] == (kind != 'scientific')
        assert client.get(f"/api/cases/{case}/sources/{source}/raw").content == bad
        bundle = client.get(f'/api/cases/{case}/revisions/{revision}/artifacts').json()
        if kind == 'scientific':
            assert bundle['available'] and bundle['manifest']['counts'] == {'ERRORS': 2}
            assert {obj['role'] for obj in bundle['artifacts']} == {'ERRORS', 'ZIP'}
            assert bundle['manifest']['reconciliation']['complete']
        else:
            assert bundle['available'] is False
        assert sweep(backend.app.state.sessions, settings) == 0


def test_serialization_diagnostics_are_durable_and_address_revision_setting(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client = backend.client()
        case = new_case(client)
        uploaded = upload(client, case, data=SOURCE).json()["result"]
        response = client.post(f"/api/cases/{case}/processing/save-and-start", json={
            "operation_id": str(uuid4()), "expected_revision_id": uploaded["revision"]["id"],
            "source_asset_id": uploaded["source"]["id"], "overrides": [{"field": "INTERNAL_OPERATOR_NAME",
            "before": "hubRTK", "after": "operator🙂", "reason": "Synthetic encoding diagnostic"}]})
        assert response.status_code == 200
        job = response.json()["result"]["job"]
        run_id = UUID(job["id"])
        with worker(backend, settings, tmp_path):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "BLOCKED")
        saved = read_run(backend, run_id)
        diagnostic = saved.error["diagnostics"][0]
        assert diagnostic["scope"] == "revision_setting" and diagnostic["field"] == "INTERNAL_OPERATOR_NAME"
        assert diagnostic["revision_id"] == job["revision_id"] and "value" not in diagnostic
        review = client.get(f"/api/cases/{case}/revisions/{job['revision_id']}/review").json()
        assert review["summary"]["output_diagnostics"] == saved.error["diagnostics"]


def test_unmarked_legacy_scientific_source_remains_blocked_without_a_diagnostic_release(backend, tmp_path):
    from test_artifact_publication import setup
    client, case, source, revision = setup(backend, legacy=True,
        data=SOURCE.replace(b'1234567894', b'7,84201E+11'))
    response = client.post(f'/api/cases/{case}/processing/start', json={
        'operation_id': str(uuid4()), 'expected_revision_id': revision})
    assert response.status_code == 200, response.text
    run_id = UUID(response.json()['result']['job']['id'])
    with runtime(backend, tmp_path) as settings:
        with worker(backend, settings, tmp_path):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == 'BLOCKED')
    saved = read_run(backend, run_id)
    assert saved.attempt == 1 and saved.summary['blocking']
    assert saved.summary['issue_counts']['inn_scientific'] == 2
    assert saved.summary['counts'] == {'CLIENTS': 0, 'DOGTAGS': 0, 'NUMBERS': 0}
    assert client.get(f'/api/cases/{case}/revisions/{revision}/artifacts').json()['available'] is False
    assert client.get(f'/api/cases/{case}/sources/{source}/raw').content == SOURCE.replace(b'1234567894', b'7,84201E+11')


def test_configured_preview_defaults_and_maximum_are_applied_to_completed_views(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, _, revision, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        backend.app.state.settings = replace(backend.settings, page_size=1, max_page_size=1)
        base = f"/api/cases/{case}/revisions/{revision}"
        artifact_id = client.get(base + "/artifacts").json()["artifacts"][2]["id"]
        endpoints = [base + "/records", base + "/issues", base + f"/artifacts/{artifact_id}/preview", "/api/cases"]
        for path in endpoints:
            response = client.get(path)
            assert response.status_code == 200 and len(response.json()["items"]) <= 1
            assert client.get(path, params={"limit": 2}).status_code == 422


def test_actual_duckdb_memory_failure_preserves_raw_and_previous_prepared_set(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, source, revision, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path / "first"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        path = f"/api/cases/{case}/revisions/{revision}/artifacts"
        original = client.get(path).json()
        response = client.post(f"/api/cases/{case}/processing/save-and-start", json={"operation_id": str(uuid4()),
                               "expected_revision_id": revision, "source_asset_id": source})
        assert response.status_code == 200
        next_job = UUID(response.json()["result"]["job"]["id"])
        limited = replace(settings, dataset_memory_limit="1KiB", max_job_attempts=1)
        with worker(backend, limited, tmp_path / "limited"):
            assert dispatch_once(backend.app.state.sessions, limited)
            wait_for(lambda: read_run(backend, next_job).state == "FAILED")
        assert read_run(backend, next_job).error["code"] == "memory_exhausted"
        assert read_run(backend, next_job).dataset_key is None
        assert client.get(path).json() == original
        assert client.get(f"/api/cases/{case}/sources/{source}/raw").content == SOURCE
