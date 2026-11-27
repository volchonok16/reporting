import os
import json
import signal
import time
from uuid import UUID, uuid4

from sqlalchemy import func, select

from app.models import Artifact, ArtifactSet, AuditEvent, ProcessingRevision, ProcessingRun
from app.processing.dispatcher import dispatch_once
from app.processing.leases import Lease
from app.processing.recovery import sweep
from app.processing.tasks import finalize
from processing_helpers import kill_worker, launch_job, read_run, runtime, wait_for, worker


def test_two_worker_processes_progress_independently(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, first = launch_job(backend)
        _, _, _, _, second = launch_job(backend)
        with worker(backend, settings, tmp_path / "first", fault="after_file_staging") as blocked:
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: (tmp_path / "first/checkpoint").exists())
            with worker(backend, settings, tmp_path / "second"):
                assert dispatch_once(backend.app.state.sessions, settings)
                wait_for(lambda: read_run(backend, second).state == "PREPARED")
                assert read_run(backend, first).state == "PROCESSING"
                assert read_run(backend, second).attempt == 1
                with backend.app.state.sessions() as db:
                    assert db.scalar(select(func.count()).select_from(ProcessingRun).where(
                        ProcessingRun.state == "PROCESSING")) == 1
                kill_worker(blocked)
                time.sleep(settings.lease_seconds + 0.1)
                sweep(backend.app.state.sessions, settings)
                time.sleep(settings.retry_backoff_seconds + 0.05)
                wait_for(lambda: dispatch_once(backend.app.state.sessions, settings))
                wait_for(lambda: read_run(backend, first).state == "PREPARED")


def test_expired_generation_resuming_after_new_worker_cannot_publish(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path / "old", fault="after_bundle_publication") as old:
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: (tmp_path / "old/checkpoint").exists())
            first = read_run(backend, run_id)
            lease = Lease(run_id, first.generation, first.lease_token)
            os.killpg(old.pid, signal.SIGSTOP)  # Stops the heartbeat along with the real consumer.
            time.sleep(settings.lease_seconds + 0.1)
            assert sweep(backend.app.state.sessions, settings) == 1
            time.sleep(settings.retry_backoff_seconds + 0.05)
            with worker(backend, settings, tmp_path / "new"):
                assert dispatch_once(backend.app.state.sessions, settings)
                wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
                (tmp_path / "old/resume").touch()
                os.killpg(old.pid, signal.SIGCONT)
                time.sleep(0.4)
            assert finalize(backend.app.state.sessions, lease, backend.app.state.storage,
                            dataset_key=None, summary={}) is False
        with backend.app.state.sessions() as db:
            saved = db.get(ProcessingRun, run_id)
            sets = db.scalars(select(ArtifactSet)).all()
            assert len(sets) == 1 and sets[0].generation == saved.generation
            assert sets[0].generation > lease.generation
            assert db.scalar(select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "processing.completed")) == 1


def test_new_head_during_old_worker_prevents_result_link_and_preserves_history(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, source, revision, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path, fault="after_bundle_publication"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: (tmp_path / "checkpoint").exists())
            response = client.post(f"/api/cases/{case}/revisions", json={"operation_id": str(uuid4()),
                                  "expected_revision_id": revision, "source_asset_id": source,
                                  "corrections": [], "overrides": []})
            assert response.status_code == 200
            new_head = response.json()["result"]["revision"]["id"]
            (tmp_path / "resume").touch()
            wait_for(lambda: read_run(backend, run_id).state == "SUPERSEDED")
        current = client.get(f"/api/cases/{case}").json()
        assert current["head_revision_id"] == new_head and current["revision"]["state"] == "DRAFT"
        assert client.get(f"/api/cases/{case}/revisions/{revision}").json()["id"] == revision
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 2
            assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 0


def test_lease_expiring_during_real_bundle_verification_rolls_back_all_links(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path / "slow", fault="slow_finalization") as slow:
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: (tmp_path / "slow/checkpoint").exists())
            time.sleep(settings.lease_seconds + 0.5)
            wait_for(lambda: slow.poll() is not None)
            assert slow.returncode == -signal.SIGKILL
            with backend.app.state.sessions() as db:
                assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 0
                assert db.scalar(select(func.count()).select_from(Artifact)) == 0
                assert db.get(ProcessingRun, run_id).dataset_key is None
            kill_worker(slow)
        assert sweep(backend.app.state.sessions, settings) == 1
        time.sleep(settings.retry_backoff_seconds + 0.05)
        with worker(backend, settings, tmp_path / "retry"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")


def test_existing_artifact_set_missing_bytes_is_verified_before_retry_and_never_repaired(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, _, revision, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path / "first"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        with backend.app.state.sessions() as db:
            artifact = db.scalar(select(Artifact).where(Artifact.role == "CLIENTS"))
            missing = backend.app.state.storage.path_for_key(artifact.storage_key)
            missing.unlink()
            run = db.get(ProcessingRun, run_id)
            run.state = "FAILED"
            run.error = {"code": "synthetic_technical_retry", "message": "Synthetic retry state", "retryable": True}
            db.commit()
        response = client.post(f"/api/cases/{case}/processing/retry", json={"operation_id": str(uuid4()),
                               "expected_revision_id": revision})
        assert response.status_code == 200
        with worker(backend, settings, tmp_path / "retry"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).attempt == 1 and read_run(backend, run_id).state == "QUEUED")
        assert not missing.exists()
        assert read_run(backend, run_id).error["code"] == "storage_integrity_error"
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 1
            assert db.get(ProcessingRun, run_id).revision_id == UUID(revision)


def test_prefork_child_loss_rejects_and_redelivers_real_rabbit_message(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        _, _, _, _, run_id = launch_job(backend)
        with worker(backend, settings, tmp_path, fault="after_claim", pool="prefork"):
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: (tmp_path / "checkpoint").exists())
            child_pid = int((tmp_path / "checkpoint").read_text())
            os.kill(child_pid, signal.SIGKILL)
            wait_for(lambda: any(json.loads(line)["redelivered"] for line in
                                 (tmp_path / "deliveries").read_text().splitlines()))
            time.sleep(settings.lease_seconds + 0.1)
            assert sweep(backend.app.state.sessions, settings) == 1
            time.sleep(settings.retry_backoff_seconds + 0.05)
            assert dispatch_once(backend.app.state.sessions, settings)
            wait_for(lambda: read_run(backend, run_id).state == "PREPARED")
        assert read_run(backend, run_id).attempt == 2
