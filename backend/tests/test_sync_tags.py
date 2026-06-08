from app.sync_service import has_excluded_tags, has_required_tags, is_excluded_sync_state
from app.tfs_client import wiql_exclude_states_clause, wiql_exclude_tags_clause


def test_has_required_tags_b2b_product() -> None:
    assert has_required_tags({"System.Tags": "b2b_product; other"}, ("b2b_product",))
    assert not has_required_tags({"System.Tags": "mixx"}, ("b2b_product",))
    assert has_required_tags({"System.Tags": "mixx"}, ())


def test_has_required_tags_error_b2b() -> None:
    assert has_required_tags({"System.Tags": "FE B2B; microservice"}, ("FE B2B", "microservice"))
    assert has_required_tags({"System.Tags": "microservice"}, ("FE B2B", "microservice"))
    assert not has_required_tags({"System.Tags": "mixx"}, ("FE B2B", "microservice"))


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

