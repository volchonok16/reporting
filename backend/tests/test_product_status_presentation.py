from unittest.mock import patch

from pptx import Presentation
from pptx.util import Pt

from app.product_status_presentation import (
    TABLE_FONT_SIZE,
    TemplateCatalog,
    _mapped_columns,
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


def test_estimate_row_height_grows_with_text() -> None:
    from app.product_status_presentation import _estimate_row_height

    short = _estimate_row_height(["", "CORE", "Коротко", ""], (14, 23, 100, 51))
    long = _estimate_row_height(["", "CORE", "Длинный текст " * 50, ""], (14, 23, 100, 51))
    assert long > short
    columns = [
        "Дата запуска",
        "Проект",
        "Описание проекта и статус",
        "Зачем и для чего делаем",
    ]
    assert _mapped_columns(columns) == columns


def test_row_values_maps_semantic_columns() -> None:
    columns = [
        "Дата запуска",
        "Проект",
        "Описание проекта и статус",
        "Зачем и для чего делаем",
    ]
    row = {
        "Дата запуска": "01.06",
        "Проект": "SMS Hub",
        "Описание проекта и статус": "Статус",
        "Зачем и для чего делаем": "Комментарий",
    }
    assert _row_values(row, columns, 4) == ["01.06", "SMS Hub", "Статус", "Комментарий"]


def test_chunk_plan_splits_long_content_across_slides() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    columns = ["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"]
    rows = [
        {
            "Дата запуска": "01.06",
            "Проект": "CORE",
            "Описание проекта": "Короткая строка",
            "Зачем и для чего делаем": "OK",
        },
        {
            "Дата запуска": "02.06",
            "Проект": "CORE",
            "Описание проекта": "Очень длинное описание " * 40,
            "Зачем и для чего делаем": "Ещё текст " * 20,
        },
        {
            "Дата запуска": "03.06",
            "Проект": "CORE",
            "Описание проекта": "Следующая строка",
            "Зачем и для чего делаем": "OK",
        },
    ]

    chunks = catalog.chunk_plan("Продуктовый офис: CORE", rows, columns)
    assert sum(len(chunk) for _, chunk in chunks) == 3
    assert len(chunks) >= 2


def test_build_specs_keeps_sheet_order() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    data = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: CORE",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[{"Дата запуска": "01.06", "Проект": "CORE", "Описание проекта": "A", "Зачем и для чего делаем": "B"}],
                totalShown=1,
            ),
            ProductStatusSheetOut(
                gid="1",
                name="Продуктовый офис: SMS",
                columns=["Дата запуска", "Проект", "Описание проекта и статус", "Зачем и для чего делаем"],
                rows=[{"Дата запуска": "", "Проект": "SMS Hub", "Описание проекта и статус": "C", "Зачем и для чего делаем": "D"}],
                totalShown=1,
            ),
        ],
    )
    from app.product_status_presentation import _build_slide_specs

    specs = _build_slide_specs(data, catalog)
    assert specs[0][0].name == "Продуктовый офис: CORE"
    assert specs[-1][0].name == "Продуктовый офис: SMS"


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
                        "Дата запуска": "",
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

    sizes: set[int] = set()
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.text_frame.paragraphs:
                if paragraph.font.size:
                    sizes.add(int(paragraph.font.size))
                for run in paragraph.runs:
                    if run.font.size:
                        sizes.add(int(run.font.size))
    assert sizes == {int(TABLE_FONT_SIZE)}
