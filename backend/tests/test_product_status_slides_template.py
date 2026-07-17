from pathlib import Path
from unittest.mock import MagicMock, patch

from app.product_status_presentation import _bundled_template_path, _open_template_presentation
from app.product_status_slides_template import (
    fetch_google_slides_pptx,
    google_slides_presentation_id,
    google_slides_pptx_export_url,
)


def test_google_slides_presentation_id_from_edit_url() -> None:
    url = "https://docs.google.com/presentation/d/1EDejas495X7XC3-pOW9QID_ooECrqNRYJBfrUpApCx4/edit"
    assert google_slides_presentation_id(url) == "1EDejas495X7XC3-pOW9QID_ooECrqNRYJBfrUpApCx4"


def test_google_slides_pptx_export_url() -> None:
    assert google_slides_pptx_export_url("abc123").endswith("/abc123/export/pptx")


def test_fetch_google_slides_pptx_reads_bytes() -> None:
    class FakeResponse:
        content = b"x" * 2048

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def get(self, url: str) -> FakeResponse:
            assert url.endswith("/export/pptx")
            return FakeResponse()

    payload = fetch_google_slides_pptx(
        reference_url="https://docs.google.com/presentation/d/abc123/edit",
        client=FakeClient(),  # type: ignore[arg-type]
    )
    assert len(payload) == 2048


def test_open_template_prefers_bundled_over_google() -> None:
    bundled = _bundled_template_path()
    assert bundled.is_file()
    with patch(
        "app.product_status_presentation.settings"
    ) as settings_mock, patch(
        "app.product_status_presentation.fetch_google_slides_pptx"
    ) as fetch_mock:
        settings_mock.b2b_product_status_presentation_template = ""
        settings_mock.b2b_product_status_presentation_reference_url = (
            "https://docs.google.com/presentation/d/abc123/edit"
        )
        prs = _open_template_presentation()
        assert len(prs.slides) >= 1
        fetch_mock.assert_not_called()


def test_open_template_uses_configured_local_path(tmp_path: Path) -> None:
    bundled = _bundled_template_path()
    local = tmp_path / "custom-template.pptx"
    local.write_bytes(bundled.read_bytes())
    with patch("app.product_status_presentation.settings") as settings_mock, patch(
        "app.product_status_presentation.fetch_google_slides_pptx"
    ) as fetch_mock:
        settings_mock.b2b_product_status_presentation_template = str(local)
        settings_mock.b2b_product_status_presentation_reference_url = (
            "https://docs.google.com/presentation/d/abc123/edit"
        )
        prs = _open_template_presentation()
        assert len(prs.slides) >= 1
        fetch_mock.assert_not_called()
