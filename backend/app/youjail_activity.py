from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.org_models import Employee
from app.org_photo_service import photo_public_url
from app.youjail_access import actor_employee_id
from app.youjail_card_keys import card_key_for_board, find_card_by_key, global_card_key, parse_card_keys
from app.youjail_models import (
    YouJailBoard,
    YouJailCard,
    YouJailCardEvent,
    YouJailCardLink,
    YouJailCardZni,
    YouJailColumn,
    YouJailProject,
)


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


def _project_name(db: Session, project_id: int | None) -> str | None:
    if project_id is None:
        return None
    project = db.get(YouJailProject, project_id)
    return project.name if project else None


def _description_preview(text: str | None, *, limit: int = 100) -> str:
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return ""
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: limit - 1].rstrip()}…"


def _format_schedule_label(iso_value: str | None) -> str | None:
    if not iso_value:
        return None
    from datetime import datetime

    try:
        normalized = iso_value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        return dt.strftime("%d.%m.%Y")
    except ValueError:
        return iso_value[:10] if len(iso_value) >= 10 else iso_value


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
        "projectName": _project_name(db, card.project_id),
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
        preview = _description_preview(after.get("descriptionMd"))
        log_card_event(
            db,
            card_id,
            "description_changed",
            meta,
            payload={"preview": preview, "cleared": not preview},
        )
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
        log_card_event(
            db,
            card_id,
            "project_changed",
            meta,
            payload={
                "fromProjectId": before.get("projectId"),
                "fromProjectName": before.get("projectName"),
                "toProjectId": after.get("projectId"),
                "toProjectName": after.get("projectName"),
            },
        )
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
        log_card_event(
            db,
            card_id,
            "scheduled_changed",
            meta,
            payload={
                "from": before.get("scheduledAt"),
                "to": after.get("scheduledAt"),
                "fromLabel": _format_schedule_label(before.get("scheduledAt")),
                "toLabel": _format_schedule_label(after.get("scheduledAt")),
            },
        )
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


def log_card_comment(db: Session, card_id: int, meta: dict, *, comment_id: int, preview: str) -> None:
    log_card_event(
        db,
        card_id,
        "comment_added",
        meta,
        payload={"commentId": comment_id, "preview": preview[:200]},
    )


def log_card_comment_edited(
    db: Session, card_id: int, meta: dict, *, comment_id: int, preview: str
) -> None:
    log_card_event(
        db,
        card_id,
        "comment_edited",
        meta,
        payload={"commentId": comment_id, "preview": preview[:200]},
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
        preview = (payload.get("preview") or "").strip()
        if preview:
            return f"Обновил описание: {preview}"
        if payload.get("cleared"):
            return "Очистил описание"
        return "Обновил описание"
    if event_type == "project_changed":
        from_name = payload.get("fromProjectName")
        to_name = payload.get("toProjectName")
        if from_name and to_name:
            return f"Изменил проект: «{from_name}» → «{to_name}»"
        if to_name:
            return f"Назначил проект: «{to_name}»"
        if from_name:
            return f"Убрал проект: «{from_name}»"
        return "Изменил проект"
    if event_type == "assignee_changed":
        to_name = payload.get("toAssigneeName") or "не назначен"
        return f"Назначил ответственного: {to_name}"
    if event_type == "scheduled_changed":
        from_label = payload.get("fromLabel") or "без срока"
        to_label = payload.get("toLabel") or "без срока"
        if to_label == "без срока" and from_label != "без срока":
            return f"Убрал срок (был {from_label})"
        if from_label == "без срока":
            return f"Установил срок: {to_label}"
        if from_label != "без срока" and to_label != "без срока":
            return f"Изменил срок: {from_label} → {to_label}"
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
    if event_type == "comment_added":
        preview = (payload.get("preview") or "").strip()
        return f"Оставил комментарий{': ' + preview if preview else ''}"
    if event_type == "comment_edited":
        preview = (payload.get("preview") or "").strip()
        return f"Изменил комментарий{': ' + preview if preview else ''}"
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


def _serialize_related_card(
    db: Session,
    card: YouJailCard,
    *,
    link_kind: str,
    viewer_employee_id: int | None = None,
) -> dict:
    board = db.get(YouJailBoard, card.board_id)
    column = db.get(YouJailColumn, card.column_id)
    return {
        "id": card.id,
        "cardKey": card_key_for_board(board, card.card_number, viewer_employee_id=viewer_employee_id)
        if board
        else f"CARD-{card.card_number}",
        "cardKeyGlobal": global_card_key(board, card.card_number) if board else f"CARD-{card.card_number}",
        "boardId": board.id if board else card.board_id,
        "boardName": board.name if board else None,
        "title": card.title,
        "columnTitle": column.title if column else None,
        "linkKind": link_kind,
    }


def list_card_relations(db: Session, card: YouJailCard, meta: dict) -> dict:
    viewer_employee_id = actor_employee_id(db, meta)
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
            related_cards.append(
                _serialize_related_card(db, other, link_kind=kind, viewer_employee_id=viewer_employee_id)
            )
    related_cards.sort(key=lambda item: (item.get("boardName") or "", item["cardKeyGlobal"]))

    manual_keys: list[str] = []
    for other_id in manual_ids:
        other = db.get(YouJailCard, other_id)
        if other is None:
            continue
        other_board = db.get(YouJailBoard, other.board_id)
        if other_board is None:
            continue
        manual_keys.append(global_card_key(other_board, other.card_number))
    return {
        "relatedCardKeys": ", ".join(sorted(manual_keys)),
        "relatedCards": related_cards,
    }


def card_related_cards_map(
    db: Session,
    card_ids: list[int],
    *,
    viewer_employee_id: int | None = None,
) -> dict[int, list[dict]]:
    if not card_ids:
        return {}

    card_id_set = set(card_ids)
    manual_by_card: dict[int, dict[int, str]] = {card_id: {} for card_id in card_ids}
    link_rows = db.scalars(
        select(YouJailCardLink).where(
            or_(
                YouJailCardLink.card_id.in_(card_ids),
                YouJailCardLink.related_card_id.in_(card_ids),
            )
        )
    ).all()
    for row in link_rows:
        if row.card_id in card_id_set:
            manual_by_card[row.card_id][row.related_card_id] = "manual"
        if row.related_card_id in card_id_set:
            manual_by_card[row.related_card_id][row.card_id] = "manual"

    source_cards = {
        row.id: row for row in db.scalars(select(YouJailCard).where(YouJailCard.id.in_(card_ids))).all()
    }

    zni_rows = db.execute(
        select(YouJailCardZni.card_id, YouJailCardZni.task_id).where(YouJailCardZni.card_id.in_(card_ids))
    ).all()
    card_tasks: dict[int, set[int]] = {card_id: set() for card_id in card_ids}
    all_task_ids: set[int] = set()
    for card_id, task_id in zni_rows:
        if card_id in card_id_set:
            card_tasks[card_id].add(task_id)
            all_task_ids.add(task_id)

    zni_related_by_card: dict[int, dict[int, str]] = {card_id: {} for card_id in card_ids}
    if all_task_ids:
        task_to_card_ids: dict[int, set[int]] = defaultdict(set)
        for other_card_id, task_id in db.execute(
            select(YouJailCardZni.card_id, YouJailCardZni.task_id).where(YouJailCardZni.task_id.in_(all_task_ids))
        ).all():
            task_to_card_ids[task_id].add(other_card_id)

        for card_id in card_ids:
            manual_ids = manual_by_card[card_id]
            for task_id in card_tasks.get(card_id, set()):
                for other_id in task_to_card_ids.get(task_id, set()):
                    if other_id == card_id or other_id in manual_ids:
                        continue
                    zni_related_by_card[card_id][other_id] = "zni"

    all_other_ids: set[int] = set()
    for card_id in card_ids:
        merged = {**zni_related_by_card[card_id], **manual_by_card[card_id]}
        all_other_ids.update(merged.keys())

    other_cards = (
        {
            row.id: row
            for row in db.scalars(select(YouJailCard).where(YouJailCard.id.in_(all_other_ids))).all()
        }
        if all_other_ids
        else {}
    )

    result: dict[int, list[dict]] = {}
    for card_id in card_ids:
        source = source_cards.get(card_id)
        merged = {**zni_related_by_card[card_id], **manual_by_card[card_id]}
        items: list[dict] = []
        for other_id, kind in merged.items():
            other = other_cards.get(other_id)
            if other is None:
                continue
            if kind == "zni" and source is not None and other.board_id != source.board_id:
                continue
            items.append(
                _serialize_related_card(db, other, link_kind=kind, viewer_employee_id=viewer_employee_id)
            )
        items.sort(key=lambda item: (item.get("boardName") or "", item["cardKeyGlobal"]))
        result[card_id] = items
    return result


def set_card_links(db: Session, card: YouJailCard, meta: dict, raw_keys: str | None) -> None:
    from app.youjail_access import assert_card_access

    keys = parse_card_keys(raw_keys)
    target_ids: list[int] = []
    target_keys: list[str] = []
    for key in keys:
        related = find_card_by_key(db, meta, key)
        assert_card_access(db, meta, related.id)
        if related.id == card.id:
            raise HTTPException(status_code=400, detail="Карточку нельзя связать саму с собой")
        related_board = db.get(YouJailBoard, related.board_id)
        global_key = global_card_key(related_board, related.card_number) if related_board else key
        target_ids.append(related.id)
        target_keys.append(global_key)

    existing_rows = list(db.scalars(select(YouJailCardLink).where(YouJailCardLink.card_id == card.id)).all())
    existing_ids = {row.related_card_id for row in existing_rows}

    for row in existing_rows:
        if row.related_card_id not in set(target_ids):
            related = db.get(YouJailCard, row.related_card_id)
            related_board = db.get(YouJailBoard, related.board_id) if related else None
            related_key = (
                global_card_key(related_board, related.card_number)
                if related is not None and related_board is not None
                else "?"
            )
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
