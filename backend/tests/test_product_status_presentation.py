from unittest.mock import patch

from pptx import Presentation

from app.product_status_presentation import (
    TemplateCatalog,
    _normalize_title,
    _row_values,
    generate_b2b_product_status_presentation,
)
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

TEMPLATE_PATH = (
    __import__("pathlib").Path(__file__).resolve().parents[1]
    / "assets"
    / "b2b_product_status_template.pptx"
)


def test_normalize_title() -> None:
    assert _normalize_title("  Продуктовый офис: CORE  ") == "продуктовый офис: core"


def test_catalog_discovers_slides_by_title() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)

    core = catalog.match("Продуктовый офис: CORE")
    assert len(core) >= 1
    assert all(item.title == "Продуктовый офис: CORE" for item in core)
    assert {item.row_count for item in core} >= {8, 9}


def test_catalog_unknown_sheet_uses_default_blueprint() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)

    template = catalog.blueprint_for("Новый лист", rows_needed=5)
    assert template.row_count >= 5


def test_row_values_uses_sheet_columns_in_order() -> None:
    columns = ["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"]
    row = {
        "Дата запуска": "01.06",
        "Проект": "CORE",
        "Описание проекта": "Перенос номеров",
        "Зачем и для чего делаем": "Выручка",
    }
    assert _row_values(row, columns, 4) == ["01.06", "CORE", "Перенос номеров", "Выручка"]


def test_chunk_plan_splits_by_template_capacity() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    rows = [{"Проект": str(index)} for index in range(17)]

    chunks = catalog.chunk_plan("Продуктовый офис: CORE", rows)
    assert sum(len(chunk) for _, chunk in chunks) == 17
    assert len(chunks) >= 2
    assert all(template.row_count >= len(chunk) for template, chunk in chunks)


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_b2b_product_status_presentation(mock_load) -> None:
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: CORE",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[
                    {
                        "Дата запуска": "01.06",
                        "Проект": "CORE",
                        "Описание проекта": "Перенос номеров",
                        "Зачем и для чего делаем": "В работе",
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
    title = next(
        shape.text_frame.text
        for shape in prs.slides[1].shapes
        if shape.has_text_frame and "заголовок" in shape.name.lower()
    )
    assert title == "Продуктовый офис: CORE"

    table = next(shape.table for shape in prs.slides[1].shapes if shape.has_table)
    assert table.rows[0].cells[1].text == "CORE"
