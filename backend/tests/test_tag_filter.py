from app.tag_filters import (
    DIGITAL_BOARD_CODE,
    TAG_FILTER_GROUPS,
    normalize_tag_group_keys,
    tag_filter_groups_for_board,
    tag_filter_supported_for_board,
    task_matches_tag_group,
    task_matches_tag_groups,
)


def test_tag_filter_for_single_boards() -> None:
    assert tag_filter_supported_for_board(DIGITAL_BOARD_CODE)
    assert tag_filter_supported_for_board("b2b_product_core")
    assert tag_filter_supported_for_board("be_t2_team")
    assert not tag_filter_supported_for_board("all")
    assert not tag_filter_supported_for_board(None)


def test_digital_tag_filter_groups() -> None:
    keys = {group.key for group in tag_filter_groups_for_board(DIGITAL_BOARD_CODE)}
    assert keys == {"newlk", "site", "eshop_b2b"}


def test_other_board_tag_filter_groups() -> None:
    keys = {group.key for group in tag_filter_groups_for_board("be_t2_team")}
    assert keys == {"eshop"}


def test_normalize_tag_group_keys_for_digital() -> None:
    assert normalize_tag_group_keys(
        ["newlk", "site", "eshop_b2b", "eshop", "unknown", "NEWLK"],
        DIGITAL_BOARD_CODE,
    ) == ["newlk", "site", "eshop_b2b"]


def test_normalize_tag_group_keys_for_other_board() -> None:
    assert normalize_tag_group_keys(
        ["eshop", "eshop_b2b", "site"],
        "be_t2_team",
    ) == ["eshop"]


def test_task_matches_eshop_b2b_group() -> None:
    group = next(item for item in TAG_FILTER_GROUPS if item.key == "eshop_b2b")
    assert task_matches_tag_group(["B2B", "EShopB2B"], group)
    assert not task_matches_tag_group(["EShop"], group)


def test_task_matches_eshop_group() -> None:
    group = next(item for item in TAG_FILTER_GROUPS if item.key == "eshop")
    assert task_matches_tag_group(["EShop", "b2b_product"], group)
    assert not task_matches_tag_group(["EShopB2B"], group)


def test_task_matches_site_group() -> None:
    site = next(group for group in TAG_FILTER_GROUPS if group.key == "site")
    assert task_matches_tag_group(["B2B", "site_b2b"], site)
    assert task_matches_tag_group(["site_portal"], site)
    assert not task_matches_tag_group(["LK_B2B", "lk_serv"], site)


def test_task_matches_newlk_group_with_subsections() -> None:
    newlk = next(group for group in TAG_FILTER_GROUPS if group.key == "newlk")
    assert task_matches_tag_group(["B2B", "DesignTasks", "LK_B2B", "lk_serv"], newlk)
    assert task_matches_tag_group(["lk_serv"], newlk)
    assert not task_matches_tag_group(["site_b2b"], newlk)


def test_task_matches_tag_groups_or_logic() -> None:
    assert task_matches_tag_groups(["site_b2b"], ["site"])
    assert task_matches_tag_groups(["lk_serv"], ["newlk"])
    assert not task_matches_tag_groups(["content"], ["site", "newlk"])
    assert task_matches_tag_groups(["content"], [])
