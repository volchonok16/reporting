"""Startup and periodic lease/outbox sweep; no checkpoint or object garbage collection."""
import logging
import time
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.db import make_engine, make_session_factory
from app.models import Outbox, ProcessingRun
from app.processing.capacity import PROCESSING_SLOTS
from app.processing.dispatcher import dispatch_batch
from app.processing.leases import (audit, clear_lease, database_now, failure, locked_run, reset_outbox)
from app.processing.tasks import make_celery
from app.settings import Settings


def sweep(sessions, settings):
    from app.domain.intakes import recover_uploads
    from app.storage.local import LocalStorage
    recovered_uploads = recover_uploads(sessions, LocalStorage(settings.storage_root))
    with sessions() as db:
        now = database_now(db)
        candidates = list(db.scalars(select(ProcessingRun.id).outerjoin(Outbox).where(
            ((ProcessingRun.state == "PROCESSING") & (ProcessingRun.lease_expires_at <= now))
            | ((ProcessingRun.state == "QUEUED") & Outbox.published_at.is_not(None)
               & (Outbox.next_attempt_at <= now)))
            .order_by(ProcessingRun.lease_expires_at.asc().nulls_last(), ProcessingRun.created_at,
                      ProcessingRun.id).limit(PROCESSING_SLOTS)))
    recovered = recovered_uploads
    for run_id in candidates:
        with sessions() as db, db.begin():
            _, run = locked_run(db, run_id)
            now = database_now(db)
            if run.state == "PROCESSING" and run.lease_expires_at and run.lease_expires_at <= now:
                clear_lease(run)
                run.generation += 1
                run.error = failure("worker_lease_expired",
                                    "Обработчик остановился. Попытка восстановлена после истечения lease.", True)
                run.progress = {"stage": "recovery", "percent": 0}
                if run.attempt >= settings.max_job_attempts:
                    run.state = "FAILED"
                    run.next_attempt_at = None
                else:
                    run.state = "QUEUED"
                    run.next_attempt_at = now + timedelta(seconds=settings.retry_backoff_seconds
                                                         * 2 ** (run.attempt - 1))
                    reset_outbox(db, run, run.next_attempt_at)
                audit(db, run, "processing.recovered", {"retry_scheduled": run.state == "QUEUED"})
                recovered += 1
            elif run.state == "QUEUED":
                outbox = db.scalar(select(Outbox).where(Outbox.run_id == run_id).with_for_update())
                if outbox.published_at and outbox.next_attempt_at and outbox.next_attempt_at <= now:
                    reset_outbox(db, run, now)
                    recovered += 1
    return recovered


def main():
    settings = Settings.from_environment()
    engine = make_engine(settings.database_url)
    sessions, app = make_session_factory(engine), make_celery(settings)
    try:
        while True:
            try:
                sweep(sessions, settings)
                dispatch_batch(sessions, settings, app)
            except SQLAlchemyError:
                logging.error("Processing dispatcher cannot reach PostgreSQL; retrying on the next sweep.")
            time.sleep(settings.recovery_interval_seconds)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
