from app.models import ZniCategory
from app.zni_category_service import ensure_zni_category
from unittest.mock import MagicMock


def test_ensure_zni_category_rejects_inactive() -> None:
    db = MagicMock()
    db.get.return_value = ZniCategory(id=1, name="Флайты", is_active=False)
    try:
        ensure_zni_category(db, 1)
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "неактивна" in str(exc)


def test_ensure_zni_category_allows_null() -> None:
    db = MagicMock()
    ensure_zni_category(db, None)
    db.get.assert_not_called()


def test_ensure_zni_category_rejects_missing() -> None:
    db = MagicMock()
    db.get.return_value = None
    try:
        ensure_zni_category(db, 99)
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "не найдена" in str(exc)
