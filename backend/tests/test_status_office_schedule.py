from datetime import datetime
from zoneinfo import ZoneInfo

from app.password_reset_mail import (
    reset_code_email_html,
    status_locked_email_html,
    status_office_lock_state_email_html,
)
from app.status_office_schedule import JOB_LOCK, JOB_REMINDER, JOB_UNLOCK, MOSCOW, jobs_due


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


def test_custom_schedule_moves_reminder_and_lock() -> None:
    from app.status_office_schedule import ScheduleSlot

    custom = {
        JOB_REMINDER: ScheduleSlot(0, 8 * 60),
        JOB_LOCK: ScheduleSlot(4, 12 * 60),
        JOB_UNLOCK: ScheduleSlot(4, 15 * 60),
    }
    assert jobs_due(_at(2026, 10, 12, 7, 59), custom) == []
    assert jobs_due(_at(2026, 10, 12, 8, 0), custom) == [JOB_REMINDER]
    assert jobs_due(_at(2026, 10, 14, 10, 0), custom) == []
    assert jobs_due(_at(2026, 10, 16, 11, 59), custom) == []
    assert jobs_due(_at(2026, 10, 16, 12, 0), custom) == [JOB_LOCK]
    assert jobs_due(_at(2026, 10, 16, 14, 59), custom) == [JOB_LOCK]
    assert jobs_due(_at(2026, 10, 16, 15, 0), custom) == [JOB_UNLOCK]


def test_two_offices_keep_separate_lock_times() -> None:
    from app.status_office_schedule import ScheduleSlot, office_jobs_due

    sms_lock = ScheduleSlot(3, 9 * 60 + 30)
    sms_unlock = ScheduleSlot(3, 18 * 60)
    core_lock = ScheduleSlot(1, 11 * 60)
    core_unlock = ScheduleSlot(1, 16 * 60)
    thursday = _at(2026, 10, 15, 9, 30)
    tuesday = _at(2026, 10, 13, 11, 0)
    assert office_jobs_due(thursday, sms_lock, sms_unlock) == [JOB_LOCK]
    assert office_jobs_due(thursday, core_lock, core_unlock) == []
    assert office_jobs_due(tuesday, core_lock, core_unlock) == [JOB_LOCK]
    assert office_jobs_due(tuesday, sms_lock, sms_unlock) == []


def test_same_day_lock_must_precede_unlock() -> None:
    from app.status_office_schedule import ScheduleSlot, save_product_status_schedule
    import pytest

    slots = {
        JOB_REMINDER: ScheduleSlot(2, 10 * 60),
        JOB_LOCK: ScheduleSlot(3, 18 * 60),
        JOB_UNLOCK: ScheduleSlot(3, 9 * 60),
    }
    with pytest.raises(ValueError, match="раньше разблокировки"):
        save_product_status_schedule(object(), slots)  # type: ignore[arg-type]


def test_office_lock_email_names_the_office() -> None:
    locked = status_office_lock_state_email_html(office_name="Офис: SMS", locked=True)
    opened = status_office_lock_state_email_html(office_name="Офис: SMS", locked=False)
    assert "«Офис: SMS» заблокирован" in locked
    assert "Офис «Офис: SMS»" not in locked
    assert "«Офис: SMS» разблокирован" in opened
    assert "Перейти к статусу" in locked


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
