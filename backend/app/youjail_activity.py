from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.org_models import Employee
from app.org_photo_service import photo_public_url
from app.youjail_access import actor_employee_id
from app.youjail_card_keys import card_key_for_board, parse_card_keys, resolve_card_number
from app.youjail_models import YouJailBoard, YouJailCard, YouJailCardEvent, YouJailCardLink, YouJailCardZni, YouJailColumn


def _actor_info(db: Session, meta: dict) -> tuple[int | None, str]:
    employee_id = actor_employee_id(db, meta)
    label = meta.get("account_label") or meta.get("login") or "Пользователь"
    if employee_id is not None:
        employee = db.get(Employee, employee_id)
        if employee is not None:
            return employee_id, employee.full_name
    return employee_id, str(label)


def log_card_event(
    db: Session,
    card_id: int,
    event_type: str,
    meta: dict,
    *,
    payload: dict | None = None,
) -> None:
    actor_id, actor_label = _actor_info(db, meta)
    db.add(
        YouJailCardEvent(
            card_id=card_id,
            event_type=event_type,
            actor_employee_id=actor_id,
            actor_label=actor_label,
            payload=payload or {},
        )
    )


def _column_title(db: Session, column_id: int | None) -> str | None:
    if column_id is None:
        return None
    column = db.get(YouJailColumn, column_id)
    return column.title if column else None


def _employee_name(db: Session, employee_id: int | None) -> str | None:
    if employee_id is None:
        return None
    employee = db.get(Employee, employee_id)
    return employee.full_name if employee else None


def card_snapshot(
    db: Session,
    card: YouJailCard,
    *,
    zni_numbers: str,
    tag_names: list[str],
) -> dict[str, Any]:
    return {
        "title": card.title,
        "descriptionMd": card.description_md or "",
        "columnId": card.column_id,
        "columnTitle": _column_title(db, card.column_id),
        "projectId": card.project_id,
        "assigneeEmployeeId": card.assignee_employee_id,
        "assigneeName": _employee_name(db, card.assignee_employee_id),
        "scheduledAt": card.scheduled_at.isoformat() if card.scheduled_at else None,
        "pinned": card.pinned,
        "archived": card.archived,
        "closedAt": card.closed_at.isoformat() if card.closed_at else None,
        "zniNumbers": zni_numbers,
        "tagNames": tag_names,
    }


def record_card_field_changes(
    db: Session,
    card_id: int,
    meta: dict,
    before: dict[str, Any],
    after: dict[str, Any],
) -> None:
    if before.get("title") != after.get("title"):
        log_card_event(
            db,
            card_id,
            "title_changed",
            meta,
            payload={"from": before.get("title"), "to": after.get("title")},
        )
    if before.get("descriptionMd") != after.get("descriptionMd"):
        log_card_event(db, card_id, "description_changed", meta)
    if before.get("columnId") != after.get("columnId"):
        log_card_event(
            db,
            card_id,
            "moved",
            meta,
            payload={
                "fromColumnId": before.get("columnId"),
                "fromColumn": before.get("columnTitle"),
                "toColumnId": after.get("columnId"),
                "toColumn": after.get("columnTitle"),
            },
        )
    if before.get("projectId") != after.get("projectId"):
        log_card_event(db, card_id, "project_changed", meta)
    if before.get("assigneeEmployeeId") != after.get("assigneeEmployeeId"):
        log_card_event(
            db,
            card_id,
            "assignee_changed",
            meta,
            payload={
                "fromAssigneeId": before.get("assigneeEmployeeId"),
                "fromAssigneeName": before.get("assigneeName"),
                "toAssigneeId": after.get("assigneeEmployeeId"),
                "toAssigneeName": after.get("assigneeName"),
            },
        )
    if before.get("scheduledAt") != after.get("scheduledAt"):
        log_card_event(db, card_id, "scheduled_changed", meta)
    if before.get("zniNumbers") != after.get("zniNumbers"):
        log_card_event(
            db,
            card_id,
            "zni_changed",
            meta,
            payload={"from": before.get("zniNumbers"), "to": after.get("zniNumbers")},
        )
    if before.get("tagNames") != after.get("tagNames"):
        log_card_event(
            db,
            card_id,
            "tags_changed",
            meta,
            payload={"from": before.get("tagNames"), "to": after.get("tagNames")},
        )


def log_card_created(db: Session, card: YouJailCard, meta: dict) -> None:
    log_card_event(
        db,
        card.id,
        "created",
        meta,
        payload={"columnId": card.column_id, "columnTitle": _column_title(db, card.column_id)},
    )


def log_card_moved(db: Session, card_id: int, meta: dict, *, from_column_id: int, to_column_id: int) -> None:
    log_card_event(
        db,
        card_id,
        "moved",
        meta,
        payload={
            "fromColumnId": from_column_id,
            "fromColumn": _column_title(db, from_column_id),
            "toColumnId": to_column_id,
            "toColumn": _column_title(db, to_column_id),
        },
    )


def log_card_flag(db: Session, card_id: int, meta: dict, event_type: str) -> None:
    log_card_event(db, card_id, event_type, meta)


def log_attachment_event(db: Session, card_id: int, meta: dict, *, added: bool, filename: str) -> None:
    log_card_event(
        db,
        card_id,
        "attachment_added" if added else "attachment_removed",
        meta,
        payload={"filename": filename},
    )


def format_event_summary(event_type: str, payload: dict) -> str:
    if event_type == "created":
        column = payload.get("columnTitle") or "колонку"
        return f"Создал карточку в «{column}»"
    if event_type == "moved":
        return f"Переместил: {payload.get('fromColumn') or '—'} → {payload.get('toColumn') or '—'}"
    if event_type == "title_changed":
        return f"Изменил название: «{payload.get('from') or '—'}» → «{payload.get('to') or '—'}»"
    if event_type == "description_changed":
        return "Обновил описание"
    if event_type == "project_changed":
        return "Изменил проект"
    if event_type == "assignee_changed":
        to_name = payload.get("toAssigneeName") or "не назначен"
        return f"Назначил ответственного: {to_name}"
    if event_type == "scheduled_changed":
        return "Изменил срок"
    if event_type == "zni_changed":
        return f"Обновил ЗНИ: {payload.get('to') or '—'}"
    if event_type == "tags_changed":
        to_tags = payload.get("to") or []
        if isinstance(to_tags, list) and to_tags:
            return f"Обновил теги: {', '.join(str(item) for item in to_tags)}"
        return "Обновил теги"
    if event_type == "pinned":
        return "Закрепил карточку"
    if event_type == "unpinned":
        return "Открепил карточку"
    if event_type == "archived":
        return "Переместил в архив"
    if event_type == "unarchived":
        return "Вернул из архива"
    if event_type == "closed":
        return "Закрыл карточку"
    if event_type == "reopened":
        return "Снова открыл карточку"
    if event_type == "attachment_added":
        return f"Прикрепил файл «{payload.get('filename') or '—'}»"
    if event_type == "attachment_removed":
        return f"Удалил вложение «{payload.get('filename') or '—'}»"
    if event_type == "link_added":
        return f"Добавил связь с {payload.get('relatedCardKey') or 'карточкой'}"
    if event_type == "link_removed":
        return f"Убрал связь с {payload.get('relatedCardKey') or 'карточкой'}"
    return event_type


def _serialize_event(db: Session, event: YouJailCardEvent) -> dict:
    employee = db.get(Employee, event.actor_employee_id) if event.actor_employee_id else None
    payload = event.payload or {}
    return {
        "id": event.id,
        "eventType": event.event_type,
        "actorEmployeeId": event.actor_employee_id,
        "actorName": employee.full_name if employee else event.actor_label,
        "actorPhotoUrl": photo_public_url(employee.photo_path) if employee else None,
        "payload": payload,
        "createdAt": event.created_at,
        "summary": format_event_summary(event.event_type, payload),
    }


def list_card_history(db: Session, card: YouJailCard, *, limit: int = 100) -> list[dict]:
    events = db.scalars(
        select(YouJailCardEvent)
        .where(YouJailCardEvent.card_id == card.id)
        .order_by(YouJailCardEvent.created_at.desc(), YouJailCardEvent.id.desc())
        .limit(limit)
    ).all()
    if events:
        return [_serialize_event(db, event) for event in events]

    column_title = _column_title(db, card.column_id)
    return [
        {
            "id": 0,
            "eventType": "created",
            "actorEmployeeId": None,
            "actorName": card.created_by or "Система",
            "actorPhotoUrl": None,
            "payload": {"columnTitle": column_title},
            "createdAt": card.created_at,
            "summary": f"Создал карточку в «{column_title or 'колонку'}»",
        }
    ]


def _serialize_related_card(db: Session, card: YouJailCard, *, link_kind: str) -> dict:
    board = db.get(YouJailBoard, card.board_id)
    column = db.get(YouJailColumn, card.column_id)
    return {
        "id": card.id,
        "cardKey": card_key_for_board(board, card.card_number) if board else f"CARD-{card.card_number}",
        "title": card.title,
        "columnTitle": column.title if column else None,
        "linkKind": link_kind,
    }


def list_card_relations(db: Session, card: YouJailCard) -> dict:
    manual_ids: dict[int, str] = {}
    rows = db.scalars(
        select(YouJailCardLink).where(
            or_(YouJailCardLink.card_id == card.id, YouJailCardLink.related_card_id == card.id)
        )
    ).all()
    for row in rows:
        other_id = row.related_card_id if row.card_id == card.id else row.card_id
        manual_ids[other_id] = "manual"

    zni_task_ids = list(
        db.scalars(select(YouJailCardZni.task_id).where(YouJailCardZni.card_id == card.id)).all()
    )
    zni_related_ids: dict[int, str] = {}
    if zni_task_ids:
        zni_rows = db.scalars(
            select(YouJailCardZni.card_id)
            .where(
                YouJailCardZni.task_id.in_(zni_task_ids),
                YouJailCardZni.card_id != card.id,
            )
            .distinct()
        ).all()
        for other_id in zni_rows:
            other = db.get(YouJailCard, other_id)
            if other is not None and other.board_id == card.board_id and other_id not in manual_ids:
                zni_related_ids[other_id] = "zni"

    related_cards: list[dict] = []
    for other_id, kind in {**zni_related_ids, **manual_ids}.items():
        other = db.get(YouJailCard, other_id)
        if other is not None:
            related_cards.append(_serialize_related_card(db, other, link_kind=kind))
    related_cards.sort(key=lambda item: item["cardKey"])

    board = db.get(YouJailBoard, card.board_id)
    manual_keys = [
        card_key_for_board(board, other.card_number) if board else f"CARD-{other.card_number}"
        for other_id in manual_ids
        if (other := db.get(YouJailCard, other_id)) is not None
    ]
    return {
        "relatedCardKeys": ", ".join(sorted(manual_keys)),
        "relatedCards": related_cards,
    }


def set_card_links(db: Session, card: YouJailCard, meta: dict, raw_keys: str | None) -> None:
    board = db.get(YouJailBoard, card.board_id)
    if board is None:
        raise HTTPException(status_code=400, detail="Доска не найдена.")
    keys = parse_card_keys(raw_keys)
    target_ids: list[int] = []
    target_keys: list[str] = []
    for key in keys:
        card_number = resolve_card_number(board, key)
        if card_number is None:
            raise HTTPException(status_code=400, detail=f"Карточка {key} не найдена на этой доске")
        related = db.scalar(
            select(YouJailCard).where(
                YouJailCard.board_id == card.board_id,
                YouJailCard.card_number == card_number,
            )
        )
        if related is None or related.id == card.id:
            raise HTTPException(status_code=400, detail=f"Карточка {key} не найдена")
        target_ids.append(related.id)
        target_keys.append(key)

    existing_rows = list(db.scalars(select(YouJailCardLink).where(YouJailCardLink.card_id == card.id)).all())
    existing_ids = {row.related_card_id for row in existing_rows}

    for row in existing_rows:
        if row.related_card_id not in set(target_ids):
            related = db.get(YouJailCard, row.related_card_id)
            related_key = card_key_for_board(board, related.card_number) if related else "?"
            log_card_event(
                db,
                card.id,
                "link_removed",
                meta,
                payload={"relatedCardId": row.related_card_id, "relatedCardKey": related_key},
            )

    db.execute(delete(YouJailCardLink).where(YouJailCardLink.card_id == card.id))
    for index, related_id in enumerate(target_ids):
        db.add(YouJailCardLink(card_id=card.id, related_card_id=related_id))
        if related_id not in existing_ids:
            log_card_event(
                db,
                card.id,
                "link_added",
                meta,
                payload={"relatedCardId": related_id, "relatedCardKey": target_keys[index]},
            )
