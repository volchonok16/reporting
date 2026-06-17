from app.app_access import (
    ROADMAP_APP_ROLE,
    ROADMAP_DIGITAL_BOARD_CODE,
    sync_board_denied_reason,
)


def test_roadmap_user_can_sync_digital_only() -> None:
    assert sync_board_denied_reason(ROADMAP_APP_ROLE, ROADMAP_DIGITAL_BOARD_CODE) is None
    assert sync_board_denied_reason(ROADMAP_APP_ROLE, "be_t2_team") is not None
    assert sync_board_denied_reason("full", "be_t2_team") is None
