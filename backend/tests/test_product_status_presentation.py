from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from pptx import Presentation

from app.product_status_presentation import (
    _build_slide_specs,
    _build_slide_title,
    _chunk_rows,
    _fill_content_slide,
    generate_b2b_product_status_presentation,
)
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut


def test_chunk_rows() -> None:
    rows = [{"a": str(index)} for index in range(7)]
    assert len(_chunk_rows(rows, 3)) == 3
    assert len(_chunk_rows([], 3)) == 1


def test_build_slide_title() -> None:
    assert _build_slide_title("SMS", 1, 1) == "SMS"
    assert _build_slide_title("SMS", 2, 3) == "SMS (2/3)"


def test_build_slide_specs() -> None:
    data = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Запуски",
                columns=["Дата", "Проект"],
                rows=[{"Дата": "01.06", "Проект": "CORE"} for _ in range(8)],
                totalShown=8,
            )
        ],
    )
    specs = _build_slide_specs(data)
    assert len(specs) == 2
    assert specs[0][2] == 1
    assert specs[1][2] == 2


def test_fill_content_slide_updates_title_and_table() -> None:
    template_path = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "assets"
        / "b2b_product_status_template.pptx"
    )
    prs = Presentation(str(template_path))
    slide = prs.slides[1]
    generated_at = datetime(2026, 6, 8, 12, 30, tzinfo=ZoneInfo("Europe/Moscow"))

    _fill_content_slide(
        slide,
        sheet_name="Запуски",
        columns=["Дата", "Проект", "Описание", "Комментарий"],
        rows=[{"Дата": "01.06", "Проект": "CORE", "Описание": "Тест", "Комментарий": "OK"}],
        page=1,
        total_pages=1,
        generated_at=generated_at,
        show_header=True,
    )

    title = next(
        shape.text_frame.text
        for shape in slide.shapes
        if shape.has_text_frame and "заголовок" in shape.name.lower()
    )
    assert "Запуски" in title
    assert "08.06.2026" in title

    table = next(shape.table for shape in slide.shapes if shape.has_table)
    assert table.rows[0].cells[0].text == "Дата"
    assert table.rows[1].cells[1].text == "CORE"


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_b2b_product_status_presentation(mock_load) -> None:
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Запуски",
                columns=["Дата", "Проект", "Описание", "Комментарий"],
                rows=[
                    {
                        "Дата": "01.06",
                        "Проект": "CORE",
                        "Описание": "Перенос номеров",
                        "Комментарий": "В работе",
                    }
                ],
                totalShown=1,
            )
        ],
    )

    content, filename = generate_b2b_product_status_presentation()
    assert filename.startswith("status-produkta-b2b-")
    assert filename.endswith(".pptx")
    assert content[:2] == b"PK"

    prs = Presentation(__import__("io").BytesIO(content))
    assert len(prs.slides) == 2
