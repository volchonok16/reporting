"""Test-only pause/kill barriers around real production entry points; no supplied results."""
import os
import json
import time
from pathlib import Path

from app.processing import tasks

fault = os.environ.get("TEST_WORKER_FAULT", "")
marker = Path(os.environ["TEST_WORKER_MARKER"])


def pause_after(function):
    def wrapped(*args, **kwargs):
        result = function(*args, **kwargs)
        if marker.exists() or result is None:
            return result
        marker.write_text(str(os.getpid()))
        while not marker.with_name("resume").exists():
            time.sleep(0.05)
        return result
    return wrapped


def pause_during_records(function):
    def wrapped(*args, **kwargs):
        for row in function(*args, **kwargs):
            yield row
            if not marker.exists():
                marker.write_text(str(os.getpid()))
                while not marker.with_name("resume").exists():
                    time.sleep(0.05)
    return wrapped


if fault == "during_discovery_read":
    from app.domain.readers.csv_reader import CSVTable
    CSVTable.records = pause_during_records(CSVTable.records)
elif fault == "during_build_read":
    from app.domain.readers.base import MappedSource
    MappedSource.records = pause_during_records(MappedSource.records)


if fault == "after_claim":
    tasks.claim = pause_after(tasks.claim)
elif fault == "after_file_staging":
    tasks.build_dataset = pause_after(tasks.build_dataset)
elif fault == "after_bundle_publication":
    tasks.publish_artifact_bundle = pause_after(tasks.publish_artifact_bundle)
elif fault == "after_finalization":
    tasks.finalize = pause_after(tasks.finalize)
elif fault == "before_cleanup":
    from app.processing import capacity
    original_clean = capacity._clean

    def slow_cleanup(root, index):
        if (root / f"slot-{index}").exists() and not marker.exists():
            marker.write_text(str(os.getpid()))
            while not marker.with_name("resume").exists():
                time.sleep(0.05)
        return original_clean(root, index)

    capacity._clean = slow_cleanup
elif fault == "slow_finalization":
    original_link = tasks.link_artifact_bundle

    def slow_real_link(*args, **kwargs):
        result = original_link(*args, **kwargs)
        marker.touch()
        time.sleep(float(os.environ["LEASE_SECONDS"]) + 0.3)
        return result

    tasks.link_artifact_bundle = slow_real_link

original_task = tasks.process_revision.run


def record_real_delivery(*args, **kwargs):
    info = tasks.process_revision.request.delivery_info
    with marker.with_name("deliveries").open("a") as stream:
        stream.write(json.dumps({"redelivered": bool(info.get("redelivered"))}) + "\n")
    result = original_task(*args, **kwargs)
    with marker.with_name("completed_deliveries").open("a") as stream:
        stream.write(json.dumps({"run_id": str(args[0])}) + "\n")
    return result


tasks.process_revision.run = record_real_delivery

if __name__ == "__main__":
    if os.environ.get("TEST_WORKER_POOL") == "prefork":
        from billiard import set_start_method
        # Docker/Linux deploys fork. Darwin's native spawn fails in Celery tracing before task entry.
        # This harness proves the deployed pool semantics; it does not claim native macOS spawn support.
        set_start_method("fork", force=True)
    tasks.celery_app.worker_main(["worker", "--pool=" + os.environ.get("TEST_WORKER_POOL", "solo"),
                                 "--concurrency=1", "--loglevel=WARNING", "--without-gossip",
                                 "--without-mingle", "--without-heartbeat"])
