from app.sync_service import has_excluded_tags, has_required_tags, is_excluded_sync_state
from app.tfs_client import wiql_exclude_states_clause, wiql_exclude_tags_clause, wiql_tags_clause


def test_has_required_tags_b2b_product() -> None:
    assert has_required_tags({"System.Tags": "b2b_product; other"}, ("b2b_product",))
    assert not has_required_tags({"System.Tags": "mixx"}, ("b2b_product",))
    assert has_required_tags({"System.Tags": "mixx"}, ())


def test_has_required_tags_match_all() -> None:
    tags = ("b2b_product", "УКП_приоритет")
    assert has_required_tags(
        {"System.Tags": "b2b_product; УКП_приоритет; other"},
        tags,
        match="all",
    )
    assert not has_required_tags({"System.Tags": "b2b_product"}, tags, match="all")
    assert not has_required_tags({"System.Tags": "УКП_приоритет"}, tags, match="all")
    # match=any (по умолчанию) — достаточно одного
    assert has_required_tags({"System.Tags": "b2b_product"}, tags, match="any")


def test_has_required_tags_error_b2b() -> None:
    tags = ("FE B2B", "microservice")
    assert has_required_tags({"System.Tags": "FE B2B; microservice"}, tags)
    assert has_required_tags({"System.Tags": "microservice"}, tags)
    assert not has_required_tags({"System.Tags": "B2B; HOLD; QA 8"}, tags)
    assert not has_required_tags({"System.Tags": "mixx"}, tags)


def test_wiql_tags_clause_any_vs_all() -> None:
    any_clause = wiql_tags_clause(("b2b_product", "УКП_приоритет"), match="any")
    all_clause = wiql_tags_clause(("b2b_product", "УКП_приоритет"), match="all")
    assert " OR " in any_clause
    assert " OR " not in all_clause
    assert "CONTAINS 'b2b_product'" in all_clause
    assert "CONTAINS 'УКП_приоритет'" in all_clause
    assert " AND " in all_clause


def test_excluded_sync_state_rejected() -> None:
    assert is_excluded_sync_state({"System.State": "Rejected"}, ("Rejected",))
    assert not is_excluded_sync_state({"System.State": "PreSolution"}, ("Rejected",))
    assert not is_excluded_sync_state({"System.State": "Rejected"}, ())


def test_wiql_exclude_states_clause() -> None:
    assert wiql_exclude_states_clause(("Rejected",)) == " AND [System.State] <> 'Rejected'"
    assert wiql_exclude_states_clause(()) == ""


def test_excluded_tag_efo() -> None:
    assert has_excluded_tags({"System.Tags": "EFO; FE B2B"}, ("EFO",))
    assert not has_excluded_tags({"System.Tags": "FE B2B; microservice"}, ("EFO",))
    assert not has_excluded_tags({"System.Tags": "FE B2B"}, ())


def test_wiql_exclude_tags_clause() -> None:
    assert wiql_exclude_tags_clause(("EFO",)) == " AND [System.Tags] NOT CONTAINS 'EFO'"
    assert wiql_exclude_tags_clause(()) == ""

