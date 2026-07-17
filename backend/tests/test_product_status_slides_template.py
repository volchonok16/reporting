from pathlib import Path
from unittest.mock import patch

from app.product_status_presentation import _bundled_template_path, _open_template_presentation


def test_bundled_template_is_status_pptx() -> None:
    bundled = _bundled_template_path()
    assert bundled.name == "Status.pptx"
    assert bundled.is_file()


def test_open_template_uses_bundled_status_pptx() -> None:
    with patch("app.product_status_presentation.settings") as settings_mock:
        settings_mock.b2b_product_status_presentation_template = ""
        prs = _open_template_presentation()
        assert len(prs.slides) >= 1


def test_open_template_uses_configured_local_path(tmp_path: Path) -> None:
    bundled = _bundled_template_path()
    local = tmp_path / "custom-template.pptx"
    local.write_bytes(bundled.read_bytes())
    with patch("app.product_status_presentation.settings") as settings_mock:
        settings_mock.b2b_product_status_presentation_template = str(local)
        prs = _open_template_presentation()
        assert len(prs.slides) >= 1
