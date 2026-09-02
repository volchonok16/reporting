from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app.notification_service import _recipient_org_user_ids, resolve_org_user_id
from app.org_models import ORG_USER_STATUS_ACTIVE, OrgUser


def test_recipient_users_requires_ids() -> None:
    db = MagicMock()
    try:
        _recipient_org_user_ids(db, audience="users", org_user_ids=[], department_ids=[])
        raise AssertionError("expected HTTPException")
    except HTTPException as exc:
        assert exc.status_code == 400


def test_recipient_departments_requires_ids() -> None:
    db = MagicMock()
    try:
        _recipient_org_user_ids(db, audience="departments", org_user_ids=[], department_ids=[])
        raise AssertionError("expected HTTPException")
    except HTTPException as exc:
        assert exc.status_code == 400


def test_resolve_org_user_id_by_session_or_email() -> None:
    db = MagicMock()
    active_user = OrgUser(id=7, email="user@t2.local", status=ORG_USER_STATUS_ACTIVE)
    db.get.return_value = active_user
    assert resolve_org_user_id(db, {"org_user_id": "7"}) == 7

    db.get.return_value = None
    with patch(
        "app.notification_service.find_org_user_by_email",
        return_value=active_user,
    ):
        assert resolve_org_user_id(db, {"app_login": "user@t2.local"}) == 7
