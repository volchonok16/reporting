from sqlalchemy import select
from sqlalchemy.orm import Session

from app.board_metrics import task_status_tokens
from app.config import settings
from app.models import Task
from app.schemas import ProductOut, ProductZniOut, ProductsOut


def _extra(task: Task) -> dict:
    return task.extra_json if isinstance(task.extra_json, dict) else {}


def _closed_states_lower() -> set[str]:
    return {value.lower() for value in settings.closed_state_list}


def _is_closed_task(task: Task) -> bool:
    return bool(task_status_tokens(task) & _closed_states_lower())


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
    assigned = extra.get("assigned_to")
    return ProductOut(
        id=str(row.id),
        number=row.external_id,
        title=row.title,
        url=row.external_url,
        status=row.source_status,
        assignedTo=str(assigned) if assigned else None,
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
