from unittest.mock import patch

import io
import re
import zipfile

from pptx import Presentation
from pptx.util import Pt

from app.product_status_presentation import (
    COVER_SECTION_NAME,
    TABLE_FONT_SIZE,
    TABLE_FONT_SIZE_DENSE,
    TemplateCatalog,
    _cell_font_size,
    _mapped_columns,
    _normalize_title,
    _read_presentation_sections,
    _row_values,
    _section_name_for_sheet,
    generate_b2b_product_status_presentation,
)
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

TEMPLATE_PATH = (
    __import__("pathlib").Path(__file__).resolve().parents[1]
    / "assets"
    / "b2b_product_status_template.pptx"
)


def test_cell_font_size_matches_template_columns() -> None:
    assert _cell_font_size(0, "июль") == (TABLE_FONT_SIZE, "1000")
    assert _cell_font_size(1, "Акция") == (TABLE_FONT_SIZE, "1000")
    long_text = "Запуск акции для абонентов программы Бизнес-окружение " * 2
    assert _cell_font_size(2, long_text) == (TABLE_FONT_SIZE, "1000")
    assert _cell_font_size(3, "") == (TABLE_FONT_SIZE_DENSE, "800")
    assert _cell_font_size(3, "Кратко") == (TABLE_FONT_SIZE_DENSE, "800")
    assert _cell_font_size(3, long_text) == (TABLE_FONT_SIZE_DENSE, "800")


def test_normalize_title() -> None:
    assert _normalize_title("  Продуктовый офис: CORE  ") == "продуктовый офис: core"


def test_section_name_for_sheet() -> None:
    assert _section_name_for_sheet("Продуктовый офис: SMS") == "SMS"
    assert _section_name_for_sheet("Продуктовый офис: VOICE") == "Voice"
    assert _section_name_for_sheet("Продуктовый офис: M2M / IoT") == "M2M / IoT"


def test_catalog_excludes_cover_slide() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    assert catalog.title_slide_index == 0
    assert all(template.index != 0 for template in catalog._templates)


def test_catalog_prefers_full_height_templates() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    pool = catalog.template_pool("Продуктовый офис: CORE")
    primary = catalog._primary_templates(pool)
    assert all(item.index in {14, 15} for item in primary)
    picked = catalog._pick_template_for_chunk(pool, 4)
    assert picked.index in {14, 15}
    assert picked.table_height >= 5_000_000


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


def test_mapped_columns_falls_back_to_column_order() -> None:
    columns = ["Месяц", "Направление", "Статус работ", "Комментарий"]
    assert _mapped_columns(columns) == columns


def test_row_values_maps_renamed_headers_by_position() -> None:
    columns = ["Месяц", "Направление", "Статус работ", "Комментарий"]
    row = {
        "Месяц": "июнь",
        "Направление": "SMS Hub",
        "Статус работ": "Настройка performance",
        "Комментарий": "Важно",
    }
    assert _row_values(row, columns, 4) == ["июнь", "SMS Hub", "Настройка performance", "Важно"]


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


def test_chunk_plan_merges_trailing_single_row_chunks() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    columns = ["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"]
    rows = [
        {
            "Дата запуска": "1",
            "Проект": "A",
            "Описание проекта": "Коротко",
            "Зачем и для чего делаем": "",
        },
        {
            "Дата запуска": "2",
            "Проект": "B",
            "Описание проекта": "Коротко",
            "Зачем и для чего делаем": "",
        },
        {
            "Дата запуска": "3",
            "Проект": "C",
            "Описание проекта": "Коротко",
            "Зачем и для чего делаем": "",
        },
    ]

    chunks = catalog.chunk_plan("Продуктовый офис: CORE", rows, columns)
    assert sum(len(chunk) for _, chunk in chunks) == 3
    assert len(chunks) == 1
    assert len(chunks[0][1]) == 3


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
            "Описание проекта": "Очень длинное описание " * 120,
            "Зачем и для чего делаем": "Ещё текст " * 80,
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
def test_generate_presentation_groups_slides_into_sections(mock_load) -> None:
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
                        "Описание проекта": "A",
                        "Зачем и для чего делаем": "B",
                    }
                ],
                totalShown=1,
            ),
            ProductStatusSheetOut(
                gid="1",
                name="Продуктовый офис: SMS",
                columns=["Дата запуска", "Проект", "Описание проекта и статус", "Зачем и для чего делаем"],
                rows=[
                    {
                        "Дата запуска": "",
                        "Проект": "SMS Hub",
                        "Описание проекта и статус": "C",
                        "Зачем и для чего делаем": "D",
                    },
                    {
                        "Дата запуска": "",
                        "Проект": "Контроль",
                        "Описание проекта и статус": "E",
                        "Зачем и для чего делаем": "F",
                    },
                ],
                totalShown=2,
            ),
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))
    slide_ids = [slide.slide_id for slide in prs.slides]
    sections = _read_presentation_sections(prs)

    assert [name for name, _ in sections] == [COVER_SECTION_NAME, "CORE", "SMS"]
    assert sections[0][1] == [slide_ids[0]]
    assert sections[1][1] == [slide_ids[1]]
    assert sections[2][1] == slide_ids[2:]


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

    cover_title = next(
        shape.text_frame.text
        for shape in prs.slides[0].shapes
        if shape.has_text_frame and "заголовок" in shape.name.lower()
    )
    assert cover_title.startswith("Статус продукта B2B")

    title = next(
        shape.text_frame.text
        for shape in prs.slides[1].shapes
        if shape.has_text_frame and "заголовок" in shape.name.lower()
    )
    assert title == "Продуктовый офис: CORE"

    table = next(shape.table for shape in prs.slides[1].shapes if shape.has_table)
    assert table.rows[0].cells[1].text == "CORE"
    assert len(table.rows) == 1

    sizes: set[int] = set()
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.text_frame.paragraphs:
                if paragraph.font.size:
                    sizes.add(int(paragraph.font.size))
                for run in paragraph.runs:
                    if run.font.size:
                        sizes.add(int(run.font.size))
    assert sizes == {int(TABLE_FONT_SIZE), int(TABLE_FONT_SIZE_DENSE)}


def _slide_xml_font_sizes(content: bytes, slide_index: int) -> set[str]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        xml = archive.read(f"ppt/slides/slide{slide_index + 1}.xml").decode("utf-8")
    return set(re.findall(r'sz="(\d+)"', xml))


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_table_height_follows_content(mock_load) -> None:
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: SMS",
                columns=["Дата запуска", "Проект", "Описание проекта и статус", "Зачем и для чего делаем"],
                rows=[
                    {
                        "Дата запуска": "",
                        "Проект": "SMS-Таргет",
                        "Описание проекта и статус": "Короткий статус",
                        "Зачем и для чего делаем": "Комментарий",
                    },
                    {
                        "Дата запуска": "04.06.",
                        "Проект": "SMS-Таргет",
                        "Описание проекта и статус": "Ещё статус",
                        "Зачем и для чего делаем": "Причина",
                    },
                    {
                        "Дата запуска": "",
                        "Проект": "",
                        "Описание проекта и статус": "Третья строка",
                        "Зачем и для чего делаем": "Цель",
                    },
                ],
                totalShown=3,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))
    table_shape = next(shape for shape in prs.slides[1].shapes if shape.has_table)
    table = table_shape.table
    row_sum = sum(int(row.height) for row in table.rows)
    assert table_shape.height == row_sum
    assert table_shape.height >= 4_500_000


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_table_cells_are_editable_xml(mock_load) -> None:
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
                        "Описание проекта": "Строка\nВторая",
                        "Зачем и для чего делаем": "OK",
                    }
                ],
                totalShown=1,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        xml = archive.read("ppt/slides/slide2.xml").decode("utf-8")

    table_xml = xml.split("<a:tbl>")[1]
    assert "graphicFrameLocks" not in xml
    assert 'anchor="t"' in table_xml
    assert "<a:buNone/>" in table_xml
    assert "<a:t>CORE</a:t>" in xml
    assert "<a:t>Строка</a:t>" in xml
    assert "<a:t>Вторая</a:t>" in xml


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_uses_column_font_sizes(mock_load) -> None:
    long_text = "Длинный текст " * 30
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: CORE",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[
                    {
                        "Дата запуска": "Июнь",
                        "Проект": "Research",
                        "Описание проекта": "BHT B2B 2026 - в работе",
                        "Зачем и для чего делаем": long_text,
                    }
                ],
                totalShown=1,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    table_sizes = _slide_xml_font_sizes(content, 1)
    assert "800" in table_sizes
    assert "1000" in table_sizes
    assert table_sizes <= {"800", "1000", "3200"}
