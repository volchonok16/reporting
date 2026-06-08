from app.sync_service import has_required_tags


def test_has_required_tags_b2b_product() -> None:
    assert has_required_tags({"System.Tags": "b2b_product; other"}, ("b2b_product",))
    assert not has_required_tags({"System.Tags": "mixx"}, ("b2b_product",))
    assert has_required_tags({"System.Tags": "mixx"}, ())


def test_has_required_tags_error_b2b() -> None:
    assert has_required_tags({"System.Tags": "FE B2B; microservice"}, ("FE B2B", "microservice"))
    assert has_required_tags({"System.Tags": "microservice"}, ("FE B2B", "microservice"))
    assert not has_required_tags({"System.Tags": "mixx"}, ("FE B2B", "microservice"))

