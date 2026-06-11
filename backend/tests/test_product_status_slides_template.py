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
