from unittest.mock import MagicMock

from fastapi import HTTPException

from app.notification_service import _recipient_org_user_ids


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
