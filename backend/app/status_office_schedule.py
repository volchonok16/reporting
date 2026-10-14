"""Расписание статуса продукта B2B по Москве.

Среда, с 10:00 — напоминание лидам и администраторам.
Четверг, с 09:30 — блокировка всех офисов и письмо о блокировке.
Четверг, с 18:00 — разблокировка всех офисов.
Повторный запуск в тот же день не дублирует действие.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

MOSCOW = ZoneInfo("Europe/Moscow")

JOB_REMINDER = "b2b_status_reminder"
JOB_LOCK = "b2b_status_lock"
JOB_UNLOCK = "b2b_status_unlock"

_stop = threading.Event()
_thread: threading.Thread | None = None


def scheduled_jobs_to_run(due: list[str], *, auto_lock: bool) -> list[str]:
    """Напоминание идёт всегда. Блокировка и разблокировка — только если автоблокировка включена."""
    if auto_lock:
        return list(due)
    return [job for job in due if job not in {JOB_LOCK, JOB_UNLOCK}]


def product_status_auto_lock_enabled(db: Session) -> bool:
    row = db.execute(
        text("SELECT auto_lock_enabled FROM b2b_product_status_settings WHERE id = 1")
    ).first()
    if row is None:
        return True
    return bool(row[0])


def jobs_due(local: datetime) -> list[str]:
    """Какие задания пора выполнить в эту минуту московского времени."""
    weekday = local.weekday()
    minutes = local.hour * 60 + local.minute
    due: list[str] = []
    if weekday == 2 and minutes >= 10 * 60:
        due.append(JOB_REMINDER)
    if weekday == 3 and 9 * 60 + 30 <= minutes < 18 * 60:
        due.append(JOB_LOCK)
    if weekday == 3 and minutes >= 18 * 60:
        due.append(JOB_UNLOCK)
    return due


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
    due = jobs_due(local)
    if not due:
        return []
    from app.b2b_product_status_db import (
        lock_all_b2b_product_status_offices,
        unlock_all_b2b_product_status_offices,
    )
    from app.db import close_db_session, get_db
    from app.password_reset_mail import (
        status_locked_email_html,
        status_locked_email_text,
        status_reminder_email_html,
        status_reminder_email_text,
    )
    from app.product_status_live import WORKBOOK_B2B, notify_product_status_saved

    db = next(get_db())
    ran: list[str] = []
    try:
        due = scheduled_jobs_to_run(due, auto_lock=product_status_auto_lock_enabled(db))
        for job_key in due:
            if not claim_job(db, job_key, local.date()):
                continue
            if job_key == JOB_REMINDER:
                _send_notice(
                    db,
                    subject="Напоминание: внесите статус продукта до конца дня",
                    html=status_reminder_email_html(today=local.date()),
                    text=status_reminder_email_text(today=local.date()),
                )
            elif job_key == JOB_LOCK:
                gids = lock_all_b2b_product_status_offices(db)
                notify_product_status_saved(
                    workbook=WORKBOOK_B2B,
                    gids=gids,
                    changed_by="schedule",
                )
                _send_notice(
                    db,
                    subject="Внесение статуса заблокировано",
                    html=status_locked_email_html(),
                    text=status_locked_email_text(),
                )
            elif job_key == JOB_UNLOCK:
                gids = unlock_all_b2b_product_status_offices(db)
                notify_product_status_saved(
                    workbook=WORKBOOK_B2B,
                    gids=gids,
                    changed_by="schedule",
                )
            ran.append(job_key)
            logger.info("Выполнено задание %s на %s", job_key, local.date().isoformat())
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
