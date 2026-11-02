from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.app_access import require_app_page
from app.db import get_db
from app.schemas import ZniCategoryOut
from app.zni_category_service import list_zni_categories

router = APIRouter(prefix="/api/zni", tags=["zni"])


@router.get("/categories", response_model=list[ZniCategoryOut])
def api_list_zni_categories(
    active_only: bool = Query(default=False, alias="activeOnly"),
    db: Session = Depends(get_db),
    _: dict = Depends(require_app_page("zni")),
) -> list[ZniCategoryOut]:
    return list_zni_categories(db, active_only=active_only)
