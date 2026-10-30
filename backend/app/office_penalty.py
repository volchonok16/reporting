"""Баллы продуктового офиса: косяк за разблокировку и ручная правка суперадмина."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def clamp_points(current: int, delta: int) -> int:
    return max(0, int(current) + int(delta))


def rank_offices(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Места от большего числа баллов к меньшему. Одинаковые баллы делят место."""
    ordered = sorted(
        rows,
        key=lambda row: (-int(row["points"]), int(row.get("sort_order") or 0), str(row["name"])),
    )
    places: list[dict[str, Any]] = []
    last_points: int | None = None
    last_place = 0
    for row in ordered:
        points = int(row["points"])
        if last_points is None or points != last_points:
            last_place += 1
            last_points = points
        places.append(
            {
                "place": last_place,
                "gid": str(row["gid"]),
                "name": str(row["name"]),
                "points": points,
                "members": list(row.get("members") or []),
            }
        )
    return places


def _office_row(db: Session, gid: str) -> dict[str, Any] | None:
    row = db.execute(
        text(
            """
            SELECT id, gid, name, penalty_points
            FROM b2b_product_status_office
            WHERE gid = :gid AND is_active = TRUE
            """
        ),
        {"gid": gid},
    ).mappings().first()
    return dict(row) if row else None


def office_penalty_points(db: Session, gid: str) -> dict[str, Any]:
    office = _office_row(db, gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")
    return {
        "gid": str(office["gid"]),
        "name": str(office["name"]),
        "points": int(office["penalty_points"]),
    }


def add_office_penalty(db: Session, *, gid: str, delta: int) -> dict[str, Any]:
    office = _office_row(db, gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")
    if delta == 0:
        raise HTTPException(status_code=400, detail="Укажите число баллов, отличное от нуля.")
    points = clamp_points(int(office["penalty_points"]), delta)
    db.execute(
        text(
            """
            UPDATE b2b_product_status_office
            SET penalty_points = :points
            WHERE id = :office_id
            """
        ),
        {"points": points, "office_id": int(office["id"])},
    )
    db.commit()
    return {"gid": str(office["gid"]), "name": str(office["name"]), "points": points}


def record_admin_unlock_penalty(db: Session, *, gid: str) -> None:
    """Один балл офису, который разблокировал обычный администратор."""
    try:
        add_office_penalty(db, gid=gid, delta=1)
    except HTTPException:
        logger.warning("Не удалось начислить балл офису gid=%s", gid)


def load_raffle(db: Session) -> list[dict[str, Any]]:
    offices = db.execute(
        text(
            """
            SELECT id, gid, name, penalty_points, sort_order
            FROM b2b_product_status_office
            WHERE is_active = TRUE
            """
        )
    ).mappings()
    rows = [dict(item) for item in offices]
    if not rows:
        return []
    members = db.execute(
        text(
            """
            SELECT m.office_id, e.full_name
            FROM b2b_product_status_office_member AS m
            JOIN employee AS e ON e.id = m.employee_id AND e.is_active = TRUE
            WHERE m.office_id = ANY(:office_ids)
            ORDER BY e.full_name, e.id
            """
        ),
        {"office_ids": [int(row["id"]) for row in rows]},
    ).mappings()
    names_by_office: dict[int, list[str]] = {}
    for item in members:
        names_by_office.setdefault(int(item["office_id"]), []).append(str(item["full_name"]))
    packed = [
        {
            "gid": row["gid"],
            "name": row["name"],
            "points": int(row["penalty_points"]),
            "sort_order": int(row["sort_order"]),
            "members": names_by_office.get(int(row["id"]), []),
        }
        for row in rows
    ]
    return rank_offices(packed)


def raffle_recipient_emails(db: Session) -> list[str]:
    rows = db.execute(
        text(
            """
            SELECT DISTINCT lower(btrim(email)) AS email
            FROM (
                SELECT u.email
                FROM org_user AS u
                WHERE u.status = 10
                  AND u.email IS NOT NULL
                UNION
                SELECT COALESCE(NULLIF(btrim(e.email), ''), NULLIF(btrim(u.email), ''))
                FROM b2b_product_status_office_member AS m
                JOIN employee AS e ON e.id = m.employee_id AND e.is_active = TRUE
                LEFT JOIN org_user AS u ON u.id = e.user_id AND u.status = 10
            ) AS recipients
            WHERE email IS NOT NULL
              AND position('@' IN btrim(email)) > 0
            """
        )
    ).scalars()
    return sorted({item.strip() for item in rows if item and str(item).strip()})


def send_raffle_results(db: Session) -> dict[str, int]:
    from app.password_reset_mail import (
        MailNotConfigured,
        MailSendError,
        send_html_mail,
        status_raffle_email_html,
        status_raffle_email_text,
    )

    places = load_raffle(db)
    recipients = raffle_recipient_emails(db)
    if not recipients:
        raise HTTPException(status_code=400, detail="Нет адресов для рассылки итогов.")
    html = status_raffle_email_html(places=places)
    text_body = status_raffle_email_text(places=places)
    subject = "Итоги баллов офисов"
    sent = 0
    failed = 0
    configured = True
    for email in recipients:
        try:
            send_html_mail(to_email=email, subject=subject, html=html, text=text_body)
            sent += 1
        except MailNotConfigured:
            configured = False
            break
        except MailSendError:
            logger.exception("Не удалось отправить итоги на %s", email)
            failed += 1
    if not configured and sent == 0:
        raise HTTPException(status_code=503, detail="Почта не настроена, итоги не отправлены.")
    return {"sent": sent, "failed": failed}
