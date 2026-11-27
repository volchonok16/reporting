"""Real RabbitMQ queues and worker subprocesses, isolated by test UUID/schema."""
import os
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from kombu import Connection, Queue
from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.models import ProcessingRun
from conftest import new_case, upload

SOURCE = ("INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n"
          "1234567894;001900;Тест;Test;1;1\r\n1234567894;002900;Тест;Test;0;0\r\n").encode()


@contextmanager
def runtime(backend, tmp_path, **overrides):
    broker_url = os.environ.get("TEST_BROKER_URL")
    if not broker_url:
        pytest.skip("Real worker proof requires explicit TEST_BROKER_URL.")
    settings = replace(backend.settings, broker_url=broker_url, processing_queue="test_" + uuid4().hex,
                       scratch_root=tmp_path / "scratch", lease_seconds=3, heartbeat_seconds=0.3,
                       retry_backoff_seconds=0.1, recovery_interval_seconds=0.2,
                       broker_timeout_seconds=1, **overrides)
    connection = Connection(broker_url, connect_timeout=1)
    try:
        connection.ensure_connection(max_retries=0)
    except Exception:
        pytest.fail("The isolated RabbitMQ fixture could not connect.", pytrace=False)
    queue = Queue(settings.processing_queue, durable=True)(connection)
    queue.declare()
    try:
        yield settings
    finally:
        queue.delete(if_unused=False, if_empty=False)
        connection.release()


def launch_job(backend, data=SOURCE):
    client = backend.client()
    case = new_case(client)
    uploaded = upload(client, case, data=data).json()["result"]
    revision = uploaded["revision"]["id"]
    response = client.post(f"/api/cases/{case}/processing/start", json={"operation_id": str(uuid4()),
                                                                    "expected_revision_id": revision})
    assert response.status_code == 200
    return client, case, uploaded["source"]["id"], revision, UUID(response.json()["result"]["job"]["id"])


def read_run(backend, run_id):
    with backend.app.state.sessions() as db:
        return db.scalar(select(ProcessingRun).where(ProcessingRun.id == run_id))


def wait_for(predicate, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    pytest.fail("The real processing boundary did not reach the expected state in time.", pytrace=False)


@contextmanager
def worker(backend, settings, tmp_path, *, fault="", pool="solo"):
    tmp_path.mkdir(parents=True, exist_ok=True)
    # Secrets go only into the child environment, never command arguments or diagnostic output.
    url = make_url(backend.settings.database_url).update_query_dict({"options": f"-c search_path={backend.schema}"})
    env = os.environ.copy()
    env.update(DATABASE_URL=url.render_as_string(hide_password=False), BROKER_URL=settings.broker_url,
               STORAGE_ROOT=str(settings.storage_root), SCRATCH_ROOT=str(settings.scratch_root),
               PROCESSING_QUEUE=settings.processing_queue, LEASE_SECONDS=str(settings.lease_seconds),
               HEARTBEAT_SECONDS=str(settings.heartbeat_seconds), MAX_JOB_ATTEMPTS=str(settings.max_job_attempts),
               RETRY_BACKOFF_SECONDS=str(settings.retry_backoff_seconds),
               RECOVERY_INTERVAL_SECONDS=str(settings.recovery_interval_seconds),
               BROKER_TIMEOUT_SECONDS=str(settings.broker_timeout_seconds),
               SCRATCH_MIN_FREE_BYTES=str(settings.scratch_min_free_bytes),
               SCRATCH_RESERVATION_BYTES=str(settings.scratch_reservation_bytes),
               DATASET_MEMORY_LIMIT=settings.dataset_memory_limit, DATASET_THREADS=str(settings.dataset_threads),
               TEST_WORKER_FAULT=fault, TEST_WORKER_MARKER=str(tmp_path / "checkpoint"), TEST_WORKER_POOL=pool,
               PYTHONPATH=str(Path(__file__).resolve().parents[2]) + os.pathsep + str(Path(__file__).parent),
               C_FORCE_ROOT="1")
    with (tmp_path / "worker.log").open("wb") as log:
        process = subprocess.Popen([sys.executable, "-m", "worker_harness"], env=env,
                                   stdout=log, stderr=log, start_new_session=True)
        try:
            yield process
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGCONT)
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)


def kill_worker(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=3)
