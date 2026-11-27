"""Outbox reserve/commit → confirmed Rabbit publish → fenced dispatch receipt."""
from datetime import timedelta
from uuid import UUID

from kombu.exceptions import KombuError
from sqlalchemy import select

from app.models import Outbox, ProcessingRun
from app.processing.capacity import PROCESSING_SLOTS
from app.processing.leases import database_now, locked_run
from app.processing.tasks import TASK_NAME, make_celery


def reserve(sessions, settings):
    with sessions() as db:
        now = database_now(db)
        candidate = db.scalar(select(Outbox.run_id).join(ProcessingRun).where(
            ProcessingRun.state == "QUEUED", Outbox.published_at.is_(None),
            (Outbox.next_attempt_at.is_(None) | (Outbox.next_attempt_at <= now)),
            (ProcessingRun.next_attempt_at.is_(None) | (ProcessingRun.next_attempt_at <= now))
        ).order_by(Outbox.created_at, Outbox.id).limit(1))
        if not candidate:
            return None
        _, run = locked_run(db, candidate)
        outbox = db.scalar(select(Outbox).where(Outbox.run_id == candidate).with_for_update())
        now = database_now(db)
        if (run.state != "QUEUED" or outbox.published_at is not None
                or (outbox.next_attempt_at and outbox.next_attempt_at > now)
                or (run.next_attempt_at and run.next_attempt_at > now)):
            return None
        outbox.attempts += 1
        # A process death during publish leaves a reservation that the next sweep can reclaim.
        outbox.next_attempt_at = now + timedelta(seconds=settings.broker_timeout_seconds
                                                + settings.recovery_interval_seconds)
        reservation = (run.id, run.generation, outbox.id, outbox.attempts)
        db.commit()
        return reservation


def confirm(sessions, reservation, settings, *, published):
    run_id, generation, outbox_id, attempt = reservation
    with sessions() as db, db.begin():
        _, run = locked_run(db, run_id)
        if not run:
            return False
        outbox = db.scalar(select(Outbox).where(Outbox.id == outbox_id).with_for_update())
        if (run.state != "QUEUED" or run.generation != generation or outbox.attempts != attempt
                or outbox.published_at is not None):
            return False
        now = database_now(db)
        if published:
            outbox.published_at = now
            outbox.next_attempt_at = now + timedelta(seconds=settings.recovery_interval_seconds)
        else:
            outbox.next_attempt_at = now + timedelta(seconds=settings.retry_backoff_seconds)
        return True


def publish_job(app, run_id):
    # No DB lock is held during connection, durable queue declaration or publisher confirmation.
    with app.connection_for_write() as connection:
        connection.ensure_connection(max_retries=0)
        with app.amqp.Producer(connection) as producer:
            app.send_task(TASK_NAME, args=[str(run_id)], producer=producer, retry=False,
                          delivery_mode=2, ignore_result=True, task_id=str(UUID(str(run_id))),
                          timeout=app.conf.broker_connection_timeout,
                          confirm_timeout=app.conf.broker_connection_timeout)


def dispatch_once(sessions, settings, app=None):
    reservation = reserve(sessions, settings)
    if reservation is None:
        return False
    app = app or make_celery(settings)
    try:
        publish_job(app, reservation[0])
    except (KombuError, OSError):
        confirm(sessions, reservation, settings, published=False)
        return False
    confirm(sessions, reservation, settings, published=True)
    return True


def dispatch_batch(sessions, settings, app=None):
    """A finite pass leaves time for recovery even while more work keeps arriving."""
    published = 0
    for _ in range(PROCESSING_SLOTS):
        if not dispatch_once(sessions, settings, app):
            break
        published += 1
    return published
