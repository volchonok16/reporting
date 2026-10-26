"""Расписание статуса продукта B2B по Москве.

Напоминание общее: b2b_product_status_schedule, по умолчанию среда с 10:00.
Автоблокировка у каждого офиса своя: b2b_product_status_office_schedule,
по умолчанию четверг 09:30 и 18:00. За 30 минут до неё сотрудникам офиса
уходит предупреждение. Меняет только суперадминистратор.
Повторный запуск в тот же день не дублирует действие.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from dataclasses import dataclass
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

MOSCOW = ZoneInfo("Europe/Moscow")

JOB_REMINDER = "b2b_status_reminder"
JOB_LOCK = "b2b_status_lock"
JOB_LOCK_SOON = "b2b_status_lock_soon"
JOB_UNLOCK = "b2b_status_unlock"
LOCK_WARNING_LEAD_MINUTES = 30

@dataclass(frozen=True)
class ScheduleSlot:
    weekday: int
    minutes: int


DEFAULT_SCHEDULE: dict[str, ScheduleSlot] = {
    JOB_REMINDER: ScheduleSlot(2, 10 * 60),
    JOB_LOCK: ScheduleSlot(3, 9 * 60 + 30),
    JOB_UNLOCK: ScheduleSlot(3, 18 * 60),
}

_stop = threading.Event()
_thread: threading.Thread | None = None


def jobs_due(local: datetime, schedule: dict[str, ScheduleSlot] | None = None) -> list[str]:
    """Какие задания пора выполнить в эту минуту московского времени."""
    slots = schedule or DEFAULT_SCHEDULE
    weekday = local.weekday()
    minutes = local.hour * 60 + local.minute
    due: list[str] = []
    reminder = slots[JOB_REMINDER]
    lock = slots[JOB_LOCK]
    unlock = slots[JOB_UNLOCK]
    if weekday == reminder.weekday and minutes >= reminder.minutes:
        due.append(JOB_REMINDER)
    if weekday == lock.weekday and minutes >= lock.minutes:
        if lock.weekday != unlock.weekday or minutes < unlock.minutes:
            due.append(JOB_LOCK)
    if weekday == unlock.weekday and minutes >= unlock.minutes:
        due.append(JOB_UNLOCK)
    return due


def format_schedule_time(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse_schedule_time(value: str) -> int:
    parts = value.strip().split(":")
    if len(parts) != 2:
        raise ValueError("Укажите время в формате ЧЧ:ММ.")
    hour = int(parts[0])
    minute = int(parts[1])
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("Укажите время в формате ЧЧ:ММ.")
    return hour * 60 + minute


def load_product_status_schedule(db: Session) -> dict[str, ScheduleSlot]:
    slots = dict(DEFAULT_SCHEDULE)
    rows = db.execute(
        text(
            """
            SELECT job_key, weekday, minutes
            FROM b2b_product_status_schedule
            """
        )
    ).mappings()
    for row in rows:
        key = str(row["job_key"])
        if key not in slots:
            continue
        slots[key] = ScheduleSlot(int(row["weekday"]), int(row["minutes"]))
    return slots


def assert_lock_before_unlock(lock: ScheduleSlot, unlock: ScheduleSlot) -> None:
    if lock.weekday == unlock.weekday and lock.minutes >= unlock.minutes:
        raise ValueError("В один день блокировка должна быть раньше разблокировки.")


def lock_is_skipped(skip_until: datetime | None, local: datetime) -> bool:
    """Офис не блокируется по расписанию, пока не наступит skip_until."""
    if skip_until is None:
        return False
    moment = skip_until if skip_until.tzinfo else skip_until.replace(tzinfo=MOSCOW)
    return moment.astimezone(MOSCOW) > local.astimezone(MOSCOW)


def parse_skip_lock_until(value: str | None) -> datetime | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError("Укажите дату и время, до которых офис не блокировать.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=MOSCOW)
    return parsed.astimezone(MOSCOW)


def lock_warning_due(local: datetime, lock: ScheduleSlot) -> bool:
    """Окно за 30 минут до блокировки этого офиса, пока блокировка ещё не наступила."""
    weekday = local.weekday()
    minutes = local.hour * 60 + local.minute
    start = lock.minutes - LOCK_WARNING_LEAD_MINUTES
    if start >= 0:
        return weekday == lock.weekday and start <= minutes < lock.minutes
    previous = (lock.weekday - 1) % 7
    if weekday == previous and minutes >= 24 * 60 + start:
        return True
    return weekday == lock.weekday and minutes < lock.minutes


def office_jobs_due(local: datetime, lock: ScheduleSlot, unlock: ScheduleSlot) -> list[str]:
    """Блокировка и разблокировка одного офиса в эту минуту."""
    weekday = local.weekday()
    minutes = local.hour * 60 + local.minute
    due: list[str] = []
    if weekday == lock.weekday and minutes >= lock.minutes:
        if lock.weekday != unlock.weekday or minutes < unlock.minutes:
            due.append(JOB_LOCK)
    if weekday == unlock.weekday and minutes >= unlock.minutes:
        due.append(JOB_UNLOCK)
    return due


def load_office_lock_slots(db: Session, office_id: int) -> tuple[ScheduleSlot, ScheduleSlot]:
    rows = db.execute(
        text(
            """
            SELECT job_key, weekday, minutes
            FROM b2b_product_status_office_schedule
            WHERE office_id = :office_id
            """
        ),
        {"office_id": office_id},
    ).mappings()
    slots = {
        JOB_LOCK: DEFAULT_SCHEDULE[JOB_LOCK],
        JOB_UNLOCK: DEFAULT_SCHEDULE[JOB_UNLOCK],
    }
    found: set[str] = set()
    for row in rows:
        key = str(row["job_key"])
        if key not in slots:
            continue
        slots[key] = ScheduleSlot(int(row["weekday"]), int(row["minutes"]))
        found.add(key)
    if found != {JOB_LOCK, JOB_UNLOCK}:
        for key in (JOB_LOCK, JOB_UNLOCK):
            if key in found:
                continue
            slot = slots[key]
            db.execute(
                text(
                    """
                    INSERT INTO b2b_product_status_office_schedule
                        (office_id, job_key, weekday, minutes)
                    VALUES (:office_id, :job_key, :weekday, :minutes)
                    ON CONFLICT (office_id, job_key) DO NOTHING
                    """
                ),
                {
                    "office_id": office_id,
                    "job_key": key,
                    "weekday": slot.weekday,
                    "minutes": slot.minutes,
                },
            )
        db.commit()
    return slots[JOB_LOCK], slots[JOB_UNLOCK]


def save_office_lock_slots(
    db: Session,
    office_id: int,
    lock: ScheduleSlot,
    unlock: ScheduleSlot,
) -> tuple[ScheduleSlot, ScheduleSlot]:
    assert_lock_before_unlock(lock, unlock)
    for key, slot in ((JOB_LOCK, lock), (JOB_UNLOCK, unlock)):
        db.execute(
            text(
                """
                INSERT INTO b2b_product_status_office_schedule
                    (office_id, job_key, weekday, minutes)
                VALUES (:office_id, :job_key, :weekday, :minutes)
                ON CONFLICT (office_id, job_key) DO UPDATE
                    SET weekday = EXCLUDED.weekday,
                        minutes = EXCLUDED.minutes
                """
            ),
            {
                "office_id": office_id,
                "job_key": key,
                "weekday": slot.weekday,
                "minutes": slot.minutes,
            },
        )
    return lock, unlock


def offices_due(db: Session, local: datetime) -> list[dict[str, object]]:
    rows = db.execute(
        text(
            """
            SELECT o.id, o.gid, o.name, o.skip_lock_until, s.job_key, s.weekday, s.minutes
            FROM b2b_product_status_office AS o
            JOIN b2b_product_status_office_schedule AS s ON s.office_id = o.id
            WHERE o.is_active = TRUE
              AND o.auto_lock_enabled = TRUE
              AND s.job_key IN ('b2b_status_lock', 'b2b_status_unlock')
            """
        )
    ).mappings()
    grouped: dict[int, dict[str, object]] = {}
    for row in rows:
        office_id = int(row["id"])
        item = grouped.setdefault(
            office_id,
            {
                "id": office_id,
                "gid": str(row["gid"]),
                "name": str(row["name"]),
                "skip_lock_until": row["skip_lock_until"],
                "slots": {},
            },
        )
        slots = item["slots"]
        assert isinstance(slots, dict)
        slots[str(row["job_key"])] = ScheduleSlot(int(row["weekday"]), int(row["minutes"]))
    due: list[dict[str, object]] = []
    for item in grouped.values():
        slots = item["slots"]
        assert isinstance(slots, dict)
        lock = slots.get(JOB_LOCK, DEFAULT_SCHEDULE[JOB_LOCK])
        unlock = slots.get(JOB_UNLOCK, DEFAULT_SCHEDULE[JOB_UNLOCK])
        skipped = lock_is_skipped(item.get("skip_lock_until"), local)  # type: ignore[arg-type]
        if lock_warning_due(local, lock) and not skipped:
            due.append(
                {
                    "id": item["id"],
                    "gid": item["gid"],
                    "name": item["name"],
                    "job_key": JOB_LOCK_SOON,
                }
            )
        for job_key in office_jobs_due(local, lock, unlock):
            if job_key == JOB_LOCK and skipped:
                continue
            due.append(
                {
                    "id": item["id"],
                    "gid": item["gid"],
                    "name": item["name"],
                    "job_key": job_key,
                }
            )
    return due


def save_product_status_schedule(db: Session, slots: dict[str, ScheduleSlot]) -> dict[str, ScheduleSlot]:
    if JOB_LOCK in slots and JOB_UNLOCK in slots:
        assert_lock_before_unlock(slots[JOB_LOCK], slots[JOB_UNLOCK])
    for key in (JOB_REMINDER, JOB_LOCK, JOB_UNLOCK):
        if key not in slots:
            continue
        slot = slots[key]
        db.execute(
            text(
                """
                INSERT INTO b2b_product_status_schedule (job_key, weekday, minutes)
                VALUES (:job_key, :weekday, :minutes)
                ON CONFLICT (job_key) DO UPDATE
                    SET weekday = EXCLUDED.weekday,
                        minutes = EXCLUDED.minutes
                """
            ),
            {"job_key": key, "weekday": slot.weekday, "minutes": slot.minutes},
        )
    db.commit()
    return load_product_status_schedule(db)


def claim_job(db: Session, job_key: str, ran_on) -> bool:
    inserted = db.execute(
        text(
            """
            INSERT INTO app_scheduled_job_run (job_key, ran_on)
            VALUES (:job_key, :ran_on)
            ON CONFLICT (job_key) DO UPDATE
                SET ran_on = EXCLUDED.ran_on,
                    ran_at = NOW()
                WHERE app_scheduled_job_run.ran_on IS DISTINCT FROM EXCLUDED.ran_on
            RETURNING job_key
            """
        ),
        {"job_key": job_key, "ran_on": ran_on},
    ).first()
    db.commit()
    return inserted is not None


def admin_member_office_gids(db: Session, org_user_id: int) -> list[str]:
    """Офисы, в состав которых входит администратор (org_user.role = 100)."""
    rows = db.execute(
        text(
            """
            SELECT o.gid
            FROM org_user AS u
            JOIN employee AS e ON e.user_id = u.id AND e.is_active = TRUE
            JOIN b2b_product_status_office_member AS m ON m.employee_id = e.id
            JOIN b2b_product_status_office AS o ON o.id = m.office_id
            WHERE u.id = :org_user_id
              AND u.status = 10
              AND u.role = 100
            ORDER BY o.sort_order, o.name
            """
        ),
        {"org_user_id": org_user_id},
    ).scalars()
    return [str(item) for item in rows]


def admin_can_unlock_office(db: Session, meta: dict | None, gid: str) -> bool:
    org_user_id = (meta or {}).get("org_user_id")
    if not org_user_id or (meta or {}).get("org_user_role") != "admin":
        return False
    return gid in admin_member_office_gids(db, int(org_user_id))


def actor_display_name(db: Session, meta: dict | None) -> str:
    org_user_id = (meta or {}).get("org_user_id")
    if org_user_id:
        row = db.execute(
            text(
                """
                SELECT COALESCE(NULLIF(btrim(e.full_name), ''), NULLIF(btrim(u.email), ''))
                FROM org_user AS u
                LEFT JOIN employee AS e ON e.user_id = u.id AND e.is_active = TRUE
                WHERE u.id = :org_user_id
                LIMIT 1
                """
            ),
            {"org_user_id": int(org_user_id)},
        ).scalar()
        if row and str(row).strip():
            return str(row).strip()
    login = (meta or {}).get("app_login")
    if isinstance(login, str) and login.strip():
        return login.strip()
    return "Администратор"


def superadmin_emails(db: Session) -> list[str]:
    rows = db.execute(
        text(
            """
            SELECT DISTINCT lower(btrim(email)) AS email
            FROM org_user
            WHERE status = 10
              AND role = 1000
              AND email IS NOT NULL
              AND position('@' IN btrim(email)) > 0
            """
        )
    ).scalars()
    return sorted({item.strip() for item in rows if item and item.strip()})


def send_admin_unlock_notice_to_superadmins(
    db: Session,
    *,
    office_name: str,
    admin_name: str,
) -> None:
    from app.password_reset_mail import (
        MailNotConfigured,
        MailSendError,
        send_html_mail,
        status_office_admin_unlock_email_html,
        status_office_admin_unlock_email_text,
    )

    recipients = superadmin_emails(db)
    subject = f"Администратор разблокировал офис «{office_name}»"
    if not recipients:
        logger.warning("Письмо «%s»: нет суперадминистраторов с почтой", subject)
        return
    html = status_office_admin_unlock_email_html(admin_name=admin_name, office_name=office_name)
    text_body = status_office_admin_unlock_email_text(admin_name=admin_name, office_name=office_name)
    for email in recipients:
        try:
            send_html_mail(to_email=email, subject=subject, html=html, text=text_body)
        except (MailNotConfigured, MailSendError):
            logger.exception("Не удалось отправить «%s» на %s", subject, email)


def is_status_office_lead(db: Session, meta: dict | None) -> bool:
    """Руководитель офиса: глава отдела, роль «Руководитель» или должность с «лид»."""
    org_user_id = (meta or {}).get("org_user_id")
    if not org_user_id:
        return False
    row = db.execute(
        text(
            """
            SELECT 1
            FROM org_user AS u
            WHERE u.id = :org_user_id
              AND u.status = 10
              AND (
                EXISTS (
                    SELECT 1
                    FROM employee AS e
                    JOIN department AS d
                      ON d.head_employee_id = e.id
                     AND d.is_active = TRUE
                    WHERE e.user_id = u.id
                      AND e.is_active = TRUE
                )
                OR EXISTS (
                    SELECT 1
                    FROM employee AS e
                    JOIN department_member AS dm ON dm.employee_id = e.id
                    LEFT JOIN team_role AS tr ON tr.id = dm.team_role_id
                    LEFT JOIN job_position AS jp ON jp.id = e.position_id
                    WHERE e.user_id = u.id
                      AND e.is_active = TRUE
                      AND (
                        tr.name = 'Руководитель'
                        OR lower(coalesce(dm.position, '')) LIKE '%лид%'
                        OR lower(coalesce(e.position, '')) LIKE '%лид%'
                        OR lower(coalesce(jp.name, '')) LIKE '%лид%'
                      )
                )
              )
            """
        ),
        {"org_user_id": int(org_user_id)},
    ).first()
    return row is not None


def status_notice_recipients(db: Session) -> list[str]:
    """Почты лидов и администраторов офиса: активные org_user admin/superadmin,
    руководители отделов и сотрудники с ролью «Руководитель» или должностью «лид».
    """
    rows = db.execute(
        text(
            """
            SELECT DISTINCT lower(email) AS email
            FROM (
                SELECT u.email
                FROM org_user AS u
                WHERE u.status = 10
                  AND u.role IN (100, 1000)
                  AND u.email IS NOT NULL
                UNION
                SELECT COALESCE(NULLIF(btrim(dm.email), ''), e.email, u.email)
                FROM department_member AS dm
                JOIN employee AS e ON e.id = dm.employee_id AND e.is_active = TRUE
                LEFT JOIN org_user AS u ON u.id = e.user_id AND u.status = 10
                LEFT JOIN team_role AS tr ON tr.id = dm.team_role_id
                LEFT JOIN job_position AS jp ON jp.id = e.position_id
                WHERE tr.name = 'Руководитель'
                   OR lower(coalesce(dm.position, '')) LIKE '%лид%'
                   OR lower(coalesce(e.position, '')) LIKE '%лид%'
                   OR lower(coalesce(jp.name, '')) LIKE '%лид%'
                UNION
                SELECT COALESCE(e.email, u.email)
                FROM department AS d
                JOIN employee AS e ON e.id = d.head_employee_id AND e.is_active = TRUE
                LEFT JOIN org_user AS u ON u.id = e.user_id AND u.status = 10
                WHERE d.is_active = TRUE
            ) AS recipients
            WHERE email IS NOT NULL
              AND position('@' IN btrim(email)) > 0
            """
        )
    ).scalars()
    return sorted({item.strip() for item in rows if item and item.strip()})


def office_member_emails(db: Session, office_id: int) -> list[str]:
    rows = db.execute(
        text(
            """
            SELECT DISTINCT lower(email) AS email
            FROM (
                SELECT COALESCE(NULLIF(btrim(e.email), ''), NULLIF(btrim(u.email), '')) AS email
                FROM b2b_product_status_office_member AS m
                JOIN employee AS e ON e.id = m.employee_id AND e.is_active = TRUE
                LEFT JOIN org_user AS u ON u.id = e.user_id AND u.status = 10
                WHERE m.office_id = :office_id
            ) AS recipients
            WHERE email IS NOT NULL
              AND position('@' IN btrim(email)) > 0
            """
        ),
        {"office_id": office_id},
    ).scalars()
    return sorted({item.strip() for item in rows if item and item.strip()})


def send_office_lock_warning(db: Session, *, office_id: int, office_name: str) -> None:
    from app.password_reset_mail import (
        MailNotConfigured,
        MailSendError,
        send_html_mail,
        status_office_lock_soon_email_html,
        status_office_lock_soon_email_text,
    )

    recipients = office_member_emails(db, office_id)
    subject = f"«{office_name}» заблокируется через 30 минут"
    if not recipients:
        logger.warning("Письмо «%s»: у офиса нет закреплённых сотрудников с почтой", subject)
        return
    html = status_office_lock_soon_email_html(office_name=office_name)
    text_body = status_office_lock_soon_email_text(office_name=office_name)
    for email in recipients:
        try:
            send_html_mail(to_email=email, subject=subject, html=html, text=text_body)
        except (MailNotConfigured, MailSendError):
            logger.exception("Не удалось отправить «%s» на %s", subject, email)


def send_office_lock_notice(db: Session, *, office_id: int, office_name: str, locked: bool) -> None:
    from app.password_reset_mail import (
        MailNotConfigured,
        MailSendError,
        send_html_mail,
        status_office_lock_state_email_html,
        status_office_lock_state_email_text,
    )

    recipients = office_member_emails(db, office_id)
    subject = (
        f"«{office_name}» заблокирован для внесения статуса"
        if locked
        else f"«{office_name}» разблокирован для внесения статуса"
    )
    if not recipients:
        logger.warning("Письмо «%s»: у офиса нет закреплённых сотрудников с почтой", subject)
        return
    html = status_office_lock_state_email_html(office_name=office_name, locked=locked)
    text_body = status_office_lock_state_email_text(office_name=office_name, locked=locked)
    for email in recipients:
        try:
            send_html_mail(to_email=email, subject=subject, html=html, text=text_body)
        except (MailNotConfigured, MailSendError):
            logger.exception("Не удалось отправить «%s» на %s", subject, email)


def send_office_lock_notice_by_gid(db: Session, *, gid: str, locked: bool) -> None:
    row = db.execute(
        text(
            """
            SELECT id, name
            FROM b2b_product_status_office
            WHERE gid = :gid AND is_active = TRUE
            """
        ),
        {"gid": gid},
    ).first()
    if row is None:
        return
    send_office_lock_notice(
        db,
        office_id=int(row[0]),
        office_name=str(row[1]),
        locked=locked,
    )


def _send_notice(db: Session, *, subject: str, html: str, text: str) -> None:
    from app.password_reset_mail import MailNotConfigured, MailSendError, send_html_mail

    recipients = status_notice_recipients(db)
    if not recipients:
        logger.warning("Письмо «%s»: нет адресатов", subject)
        return
    for email in recipients:
        try:
            send_html_mail(to_email=email, subject=subject, html=html, text=text)
        except (MailNotConfigured, MailSendError):
            logger.exception("Не удалось отправить «%s» на %s", subject, email)


def run_due_jobs(now: datetime | None = None) -> list[str]:
    local = (now or datetime.now(MOSCOW)).astimezone(MOSCOW)
    from app.b2b_product_status_db import set_auto_lock_offices_editing_locked
    from app.db import close_db_session, get_db
    from app.password_reset_mail import (
        status_reminder_email_html,
        status_reminder_email_text,
    )
    from app.product_status_live import WORKBOOK_B2B, notify_product_status_saved

    db = next(get_db())
    ran: list[str] = []
    try:
        if JOB_REMINDER in jobs_due(local, load_product_status_schedule(db)):
            if claim_job(db, JOB_REMINDER, local.date()):
                _send_notice(
                    db,
                    subject="Напоминание: внесите статус продукта до конца дня",
                    html=status_reminder_email_html(today=local.date()),
                    text=status_reminder_email_text(today=local.date()),
                )
                ran.append(JOB_REMINDER)
                logger.info("Выполнено задание %s на %s", JOB_REMINDER, local.date().isoformat())
        for item in offices_due(db, local):
            job_key = str(item["job_key"])
            claim_key = f"{job_key}:{item['id']}"
            if not claim_job(db, claim_key, local.date()):
                continue
            if job_key == JOB_LOCK_SOON:
                send_office_lock_warning(
                    db,
                    office_id=int(item["id"]),
                    office_name=str(item["name"]),
                )
                ran.append(claim_key)
                logger.info("Выполнено задание %s на %s", claim_key, local.date().isoformat())
                continue
            locked = job_key == JOB_LOCK
            offices = set_auto_lock_offices_editing_locked(
                db,
                locked=locked,
                office_ids=[int(item["id"])],
            )
            if offices:
                notify_product_status_saved(
                    workbook=WORKBOOK_B2B,
                    gids=[str(office["gid"]) for office in offices],
                    changed_by="schedule",
                )
            for office in offices:
                send_office_lock_notice(
                    db,
                    office_id=int(office["id"]),
                    office_name=str(office["name"]),
                    locked=locked,
                )
            ran.append(claim_key)
            logger.info("Выполнено задание %s на %s", claim_key, local.date().isoformat())
    finally:
        close_db_session(db)
    return ran


def _loop() -> None:
    while not _stop.is_set():
        try:
            run_due_jobs()
        except Exception:
            logger.exception("Сбой расписания статуса продукта")
        _stop.wait(60)


def start_status_office_schedule() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="b2b-status-schedule", daemon=True)
    _thread.start()


def stop_status_office_schedule() -> None:
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=2)
