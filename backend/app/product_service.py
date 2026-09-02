from sqlalchemy import select
from sqlalchemy.orm import Session

from app.board_metrics import task_status_tokens
from app.boards import board_by_code, get_boards
from app.config import settings
from app.models import Task
from app.product_fields import board_for_area_path
from app.schemas import ProductOut, ProductZniOut, ProductsOut


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


def _closed_states_lower() -> set[str]:
    return {value.lower() for value in settings.closed_state_list}


def _is_closed_task(task: Task) -> bool:
    return bool(task_status_tokens(task) & _closed_states_lower())


def _product_owner(extra: dict) -> str | None:
    owner = extra.get("project_owner") or extra.get("customer_name") or extra.get("assigned_to")
    if owner is None:
        return None
    text = str(owner).strip()
    return text or None


def _product_board(extra: dict, *, source_team: str | None) -> tuple[str | None, str | None]:
    board_code = extra.get("board_code")
    board_name = extra.get("board_name")
    if board_code or board_name:
        code = str(board_code) if board_code else None
        name = str(board_name) if board_name else None
        if code and not name:
            matched = board_by_code(code, get_boards())
            name = matched.display_name if matched else source_team
        return code, name or source_team

    area_path = extra.get("area_path")
    matched = board_for_area_path(str(area_path) if area_path else None)
    if matched is not None:
        return matched.code, matched.display_name
    team = (source_team or "").strip()
    return None, team or None


def _product_zni_to_out(row: Task) -> ProductZniOut:
    extra = _extra(row)
    board_code = extra.get("board_code")
    return ProductZniOut(
        id=str(row.id),
        number=row.external_id,
        title=row.title,
        url=row.external_url,
        status=row.source_status,
        boardCode=str(board_code) if board_code else None,
        boardName=row.source_team,
    )


def _product_to_out(row: Task, zni_rows: list[Task]) -> ProductOut:
    extra = _extra(row)
    tags = extra.get("tags")
    tag_list = [str(tag) for tag in tags] if isinstance(tags, list) else []
    board_code, board_name = _product_board(extra, source_team=row.source_team)
    return ProductOut(
        id=str(row.id),
        number=row.external_id,
        title=row.title,
        url=row.external_url,
        status=row.source_status,
        projectOwner=_product_owner(extra),
        boardCode=board_code,
        boardName=board_name,
        tags=tag_list,
        zniCount=len(zni_rows),
        zniItems=[_product_zni_to_out(zni) for zni in zni_rows],
    )


def load_products(db: Session, *, hide_closed: bool = True) -> ProductsOut:
    products = list(
        db.scalars(
            select(Task)
            .where(Task.task_type == "product")
            .order_by(Task.external_id.desc())
        )
    )
    if not products:
        return ProductsOut(items=[], totalShown=0)

    product_ids = [row.id for row in products]
    zni_rows = list(
        db.scalars(
            select(Task).where(
                Task.task_type == "change_request",
                Task.parent_task_id.in_(product_ids),
            )
        )
    )
    znis_by_parent: dict[int, list[Task]] = {}
    for zni in zni_rows:
        if zni.parent_task_id is None:
            continue
        znis_by_parent.setdefault(zni.parent_task_id, []).append(zni)

    items: list[ProductOut] = []
    for product in products:
        children = znis_by_parent.get(product.id, [])
        if hide_closed:
            children = [row for row in children if not _is_closed_task(row)]
        children.sort(key=lambda row: row.external_id, reverse=True)
        items.append(_product_to_out(product, children))

    return ProductsOut(items=items, totalShown=len(items))
