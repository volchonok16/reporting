from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.app_access import (
    ROADMAP_APP_ROLE,
    ROADMAP_DIGITAL_BOARD_CODE,
    sync_board_denied_reason,
)
from app.main import require_full_app_access


def test_roadmap_user_can_sync_digital_only() -> None:
    assert sync_board_denied_reason(ROADMAP_APP_ROLE, ROADMAP_DIGITAL_BOARD_CODE) is None
    assert sync_board_denied_reason(ROADMAP_APP_ROLE, "be_t2_team") is not None
    assert sync_board_denied_reason("full", "be_t2_team") is None


def test_require_full_app_access_denies_roadmap_role() -> None:
    with patch("app.main.get_session", return_value=object()), patch(
        "app.main.get_session_with_meta",
        return_value=(object(), {"app_role": ROADMAP_APP_ROLE}),
    ):
        with pytest.raises(HTTPException) as exc_info:
            require_full_app_access("session-id")
    assert exc_info.value.status_code == 403


def test_require_full_app_access_allows_full_role() -> None:
    with patch("app.main.get_session", return_value=object()), patch(
        "app.main.get_session_with_meta",
        return_value=(object(), {"app_role": "full"}),
    ):
        require_full_app_access("session-id")
