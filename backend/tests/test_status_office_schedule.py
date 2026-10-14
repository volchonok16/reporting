from datetime import datetime
from zoneinfo import ZoneInfo

from app.password_reset_mail import reset_code_email_html, status_locked_email_html
from app.status_office_schedule import (
    JOB_LOCK,
    JOB_REMINDER,
    JOB_UNLOCK,
    MOSCOW,
    jobs_due,
    scheduled_jobs_to_run,
)


def _at(year: int, month: int, day: int, hour: int, minute: int) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=MOSCOW)


def test_wednesday_morning_sends_reminder_only_from_10() -> None:
    assert jobs_due(_at(2026, 10, 14, 9, 59)) == []
    assert jobs_due(_at(2026, 10, 14, 10, 0)) == [JOB_REMINDER]


def test_thursday_locks_at_0930_and_unlocks_at_1800() -> None:
    assert jobs_due(_at(2026, 10, 15, 9, 29)) == []
    assert jobs_due(_at(2026, 10, 15, 9, 30)) == [JOB_LOCK]
    assert jobs_due(_at(2026, 10, 15, 17, 59)) == [JOB_LOCK]
    assert jobs_due(_at(2026, 10, 15, 18, 0)) == [JOB_UNLOCK]


def test_auto_lock_flag_skips_lock_and_keeps_reminder() -> None:
    due = [JOB_REMINDER, JOB_LOCK, JOB_UNLOCK]
    assert scheduled_jobs_to_run(due, auto_lock=True) == due
    assert scheduled_jobs_to_run(due, auto_lock=False) == [JOB_REMINDER]
    assert scheduled_jobs_to_run([JOB_LOCK], auto_lock=False) == []


def test_locked_email_names_contacts_and_reset_email_keeps_code() -> None:
    locked = status_locked_email_html()
    assert "Склярову Ивану" in locked
    assert "Тараскину Александру" in locked
    assert "+7-909" not in locked
    assert "http://t2product.ru/?sheet=product-status-b2b" in locked
    assert "Перейти к статусу" in locked
    reset = reset_code_email_html(code="482913")
    assert "482913" in reset
    assert "Перейти к статусу" not in reset
    assert ZoneInfo("Europe/Moscow") is MOSCOW
