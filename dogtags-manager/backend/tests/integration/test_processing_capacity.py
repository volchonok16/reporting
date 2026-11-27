"""Shared logical and physical limits across real processing consumers."""
import os
import shutil
import signal
import time
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from uuid import UUID

from sqlalchemy import func, select

from app.models import ArtifactSet, Outbox, ProcessingRun, utcnow
from app.processing.dispatcher import dispatch_batch, publish_job
from app.processing.leases import claim
from app.processing.recovery import sweep
from app.processing.tasks import make_celery, process_run
from processing_helpers import kill_worker, launch_job, read_run, runtime, wait_for, worker
from test_automatic_intake import receive, seed


def test_four_claims_admit_and_fifth_waits_without_spending_attempt(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        jobs = [launch_job(backend)[-1] for _ in range(5)]
        leases = [claim(backend.app.state.sessions, job, settings) for job in jobs]
        assert sum(lease is not None for lease in leases) == 4
        assert read_run(backend, jobs[4]).state == "QUEUED"
        assert read_run(backend, jobs[4]).attempt == 0


def test_five_real_consumers_share_four_slots_and_next_file_advances(backend, tmp_path):
    with runtime(backend, tmp_path) as settings, ExitStack() as stack:
        jobs = [launch_job(backend)[-1] for _ in range(5)]
        app = make_celery(settings)
        for i in range(4):
            stack.enter_context(worker(backend, settings, tmp_path / str(i), fault="after_file_staging"))
            publish_job(app, jobs[i])
            wait_for(lambda: (tmp_path / str(i) / "checkpoint").exists())
        assert len({(tmp_path / str(i) / "checkpoint").read_text() for i in range(4)}) == 4
        stack.enter_context(worker(backend, settings, tmp_path / "fifth"))
        publish_job(app, jobs[4])
        wait_for(lambda: (tmp_path / "fifth/deliveries").exists())
        assert read_run(backend, jobs[4]).attempt == 0
        with backend.app.state.sessions() as db:
            assert db.scalar(select(func.count()).select_from(ProcessingRun).where(
                ProcessingRun.state == "PROCESSING")) == 4
        (tmp_path / "0/resume").touch()
        wait_for(lambda: read_run(backend, jobs[0]).state == "PREPARED")
        publish_job(app, jobs[4])
        wait_for(lambda: read_run(backend, jobs[4]).state == "PREPARED")
        assert read_run(backend, jobs[4]).attempt == 1


def test_stopped_process_keeps_physical_slot_after_lease_expiry(backend, tmp_path):
    with runtime(backend, tmp_path) as settings, ExitStack() as stack:
        jobs = [launch_job(backend)[-1] for _ in range(5)]
        app = make_celery(settings)
        processes = []
        for i in range(4):
            processes.append(stack.enter_context(worker(backend, settings, tmp_path / str(i),
                                                       fault="after_file_staging")))
            publish_job(app, jobs[i])
            wait_for(lambda: (tmp_path / str(i) / "checkpoint").exists())
        os.killpg(processes[0].pid, signal.SIGSTOP)
        stale_generation = read_run(backend, jobs[0]).generation
        time.sleep(settings.lease_seconds + 0.1)
        assert sweep(backend.app.state.sessions, settings) == 1
        stack.enter_context(worker(backend, settings, tmp_path / "fifth"))
        publish_job(app, jobs[4])
        wait_for(lambda: (tmp_path / "fifth/deliveries").exists())
        assert read_run(backend, jobs[4]).attempt == 0
        assert len(list((settings.scratch_root / "capacity").glob("*.reserved"))) == 4
        os.killpg(processes[0].pid, signal.SIGCONT)
        wait_for(lambda: processes[0].poll() is not None)
        assert processes[0].returncode == -signal.SIGKILL
        publish_job(app, jobs[4])
        wait_for(lambda: read_run(backend, jobs[4]).state == "PREPARED")
        with backend.app.state.sessions() as db:
            assert not db.scalar(select(ArtifactSet).where(
                ArtifactSet.revision_id == read_run(backend, jobs[0]).revision_id,
                ArtifactSet.generation == stale_generation))
        assert read_run(backend, jobs[4]).attempt == 1


def test_heartbeat_loss_stops_inflight_computation_and_crash_cleanup_frees_disk(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        settings.scratch_root.mkdir()
        settings = replace(settings, scratch_reservation_bytes=shutil.disk_usage(settings.scratch_root).free * 3 // 5)
        first, second = [launch_job(backend)[-1] for _ in range(2)]
        app = make_celery(settings)
        with worker(backend, settings, tmp_path / "first", fault="after_file_staging") as old:
            publish_job(app, first)
            wait_for(lambda: (tmp_path / "first/checkpoint").exists())
            with worker(backend, settings, tmp_path / "second"):
                publish_job(app, second)
                wait_for(lambda: (tmp_path / "second/deliveries").exists())
                assert read_run(backend, second).attempt == 0
            with backend.app.state.sessions() as db:
                run = db.get(ProcessingRun, first)
                run.generation += 1  # Durable ownership loss while the native work boundary is paused.
                db.commit()
            wait_for(lambda: old.poll() is not None)
            assert old.returncode == -signal.SIGKILL
            capacity = settings.scratch_root / "capacity"
            assert list(capacity.glob("*.reserved"))
            assert (capacity / "slot-0/dataset").exists()
            with worker(backend, settings, tmp_path / "restarted"):
                publish_job(app, second)
                wait_for(lambda: read_run(backend, second).state == "PREPARED")
                wait_for(lambda: not list(capacity.glob("*.reserved")))
                assert not (capacity / "slot-0").exists()
                assert read_run(backend, first).dataset_key is None


def test_discovery_human_wait_and_failed_file_release_shared_slots(backend, tmp_path):
    seed(backend)
    client = backend.client()
    incoming = receive(client, data=b"unmapped;columns\nvalue;other\n").json()['result']
    discovery = UUID(incoming['job']['id'])
    with runtime(backend, tmp_path) as settings:
        broken, good = [launch_job(backend)[-1] for _ in range(2)]
        app = make_celery(settings)
        with worker(backend, settings, tmp_path / "discover", fault="after_claim") as paused:
            publish_job(app, discovery)
            wait_for(lambda: (tmp_path / "discover/checkpoint").exists())
            # DISCOVER occupies one of the same four DB slots as BUILD.
            leases = [claim(backend.app.state.sessions, launch_job(backend)[-1], settings) for _ in range(4)]
            assert sum(lease is not None for lease in leases) == 3
            (tmp_path / "discover/resume").touch()
            wait_for(lambda: read_run(backend, discovery).state == "COMPLETE")
            state = client.get(f"/api/intakes/{incoming['intake']['id']}").json()
            assert state['intake']['state'] == 'NEEDS_DECISION'
            kill_worker(paused)
        # Release test-only claims so the real failure and next source can run.
        time.sleep(settings.lease_seconds + 0.1)
        limited = replace(settings, dataset_memory_limit="1KiB", max_job_attempts=1)
        with worker(backend, limited, tmp_path / "failed"):
            publish_job(app, broken)
            wait_for(lambda: read_run(backend, broken).state == "FAILED")
        with worker(backend, settings, tmp_path / "good"):
            publish_job(app, good)
            wait_for(lambda: read_run(backend, good).state == "PREPARED")


def test_completed_job_retains_reservation_until_cleanup_finishes(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        first, second = [launch_job(backend)[-1] for _ in range(2)]
        app = make_celery(settings)
        with worker(backend, settings, tmp_path / "cleanup", fault="before_cleanup"):
            publish_job(app, first)
            wait_for(lambda: (tmp_path / "cleanup/checkpoint").exists())
            assert read_run(backend, first).state == "PREPARED"
            capacity = settings.scratch_root / "capacity"
            assert list(capacity.glob("*.reserved"))
            assert (capacity / "slot-0/dataset").exists()
            with worker(backend, settings, tmp_path / "next"):
                publish_job(app, second)
                wait_for(lambda: (tmp_path / "next/deliveries").exists())
                assert read_run(backend, second).attempt == 0
                (tmp_path / "cleanup/resume").touch()
                wait_for(lambda: read_run(backend, second).state == "PREPARED")
                wait_for(lambda: not list(capacity.glob("*.reserved")))


def test_dispatcher_publishes_bounded_four_message_pass(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        for _ in range(5):
            launch_job(backend)
        assert dispatch_batch(backend.app.state.sessions, settings) == 4
        assert dispatch_batch(backend.app.state.sessions, settings) == 1


def test_recovery_limits_each_pass_without_losing_waiting_deliveries(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        for _ in range(5):
            launch_job(backend)
        with backend.app.state.sessions() as db:
            for outbox in db.scalars(select(Outbox)):
                outbox.published_at = outbox.next_attempt_at = utcnow()
            db.commit()
        assert sweep(backend.app.state.sessions, settings) == 4
        assert sweep(backend.app.state.sessions, settings) == 1


def test_scratch_admission_io_error_is_visible_without_spending_attempt(backend, tmp_path):
    with runtime(backend, tmp_path) as settings:
        client, case, _, _, job = launch_job(backend)
        settings.scratch_root.write_text('A file cannot be a scratch directory')
        process_run(backend.app.state.sessions, job, settings)
        status = client.get(f'/api/cases/{case}/processing/{job}').json()
        assert status['state'] == 'QUEUED' and status['attempt'] == 0
        assert status['error']['code'] == 'scratch_unavailable'
        assert status['error']['retryable'] is True
        assert status['progress']['stage'] == 'capacity_wait'
        settings.scratch_root.unlink()
        time.sleep(settings.retry_backoff_seconds + 0.05)
        process_run(backend.app.state.sessions, job, settings)
        assert read_run(backend, job).state == 'PREPARED'
        assert read_run(backend, job).attempt == 1


def test_uncleanable_slots_keep_reservations_and_explain_wait(backend, tmp_path, monkeypatch):
    from app.processing import capacity

    real_rmtree = capacity.shutil.rmtree

    with runtime(backend, tmp_path) as settings:
        def unavailable_cleanup(path, *args, **kwargs):
            if Path(path).parent == settings.scratch_root / 'capacity':
                raise PermissionError('Synthetic scratch cleanup failure')
            return real_rmtree(path, *args, **kwargs)

        jobs = [launch_job(backend)[-1] for _ in range(5)]
        monkeypatch.setattr(capacity.shutil, 'rmtree', unavailable_cleanup)
        for job in jobs:
            process_run(backend.app.state.sessions, job, settings)
        assert all(read_run(backend, job).state == 'PREPARED' for job in jobs[:4])
        waiting = read_run(backend, jobs[4])
        assert waiting.state == 'QUEUED' and waiting.attempt == 0
        assert waiting.error['code'] == 'scratch_unavailable'
        assert waiting.progress['stage'] == 'capacity_wait'
        assert len(list((settings.scratch_root / 'capacity').glob('*.reserved'))) == 4
