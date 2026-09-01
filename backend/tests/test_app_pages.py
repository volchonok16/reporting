from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.app_page_service import is_other_user_employee, set_user_page_access
from app.app_pages import APP_PAGES


def test_app_pages_registry_matches_workbook() -> None:
    keys = {page["page_key"] for page in APP_PAGES}
    assert keys == {
        "zni",
        "products",
        "product-status-b2b",
        "revenue-activities",
        "roadmap",
        "youjail-board",
        "departments",
        "diagrams",
        "planning",
        "voice",
    }


def test_is_other_user_employee() -> None:
    employee = MagicMock(hide_from_pyramid=True)
    assert is_other_user_employee(employee)
    assert not is_other_user_employee(None)
    employee.hide_from_pyramid = False
    assert not is_other_user_employee(employee)


def test_set_user_page_access_rejects_unknown_key() -> None:
    db = MagicMock()
    with pytest.raises(HTTPException) as exc_info:
        set_user_page_access(db, 1, ["unknown-page"])
    assert exc_info.value.status_code == 400
