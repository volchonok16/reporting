from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.app_access import is_roadmap_role, is_voice_only
from app.auth_sessions import get_session_with_meta
from app.db import get_db
from app.schemas import ZniCategoryOut
from app.zni_category_service import list_zni_categories

router = APIRouter(prefix="/api/zni", tags=["zni"])


def _load_session_meta(
    x_session_id: str | None = Header(default=None, alias="X-Session-Id"),
) -> dict:
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_voice_only(meta):
        raise HTTPException(status_code=403, detail="Доступен только раздел Voice.")
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    return meta


@router.get("/categories", response_model=list[ZniCategoryOut])
def api_list_zni_categories(
    active_only: bool = Query(default=False, alias="activeOnly"),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[ZniCategoryOut]:
    return list_zni_categories(db, active_only=active_only)
