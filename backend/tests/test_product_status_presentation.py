from unittest.mock import patch

import io
import re

from pptx import Presentation
from pptx.util import Pt

from app.product_status_presentation import (
    DATE_PLACEHOLDER,
    FIXED_SLIDE_COUNT,
    MARKET_NEWS_SLIDE_INDEX,
    TABLE_FONT_SIZE,
    TABLE_FONT_SIZE_DENSE,
    TemplateCatalog,
    _cell_font_size,
    _chunk_rows,
    _estimate_row_height,
    _estimate_text_lines,
    _mapped_columns,
    _market_news_lines,
    _normalize_title,
    _row_values,
    _section_name_for_sheet,
    _template_index_for_sheet,
    generate_b2b_product_status_presentation,
)
from app.product_status_presentation import _column_chars_per_line, _column_widths, BODY_WIDTH_EMU
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

TEMPLATE_PATH = (
    __import__("pathlib").Path(__file__).resolve().parents[1]
    / "assets"
    / "b2b_product_status_template.pptx"
)


def test_template_has_status_structure() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    assert len(prs.slides) >= 8
    texts = [shape.text_frame.text for shape in prs.slides[0].shapes if shape.has_text_frame]
    assert DATE_PLACEHOLDER in "".join(texts)


def test_cell_font_size_matches_template_columns() -> None:
    assert _cell_font_size(0, "июль") == (TABLE_FONT_SIZE, "1000")
    assert _cell_font_size(3, "Кратко") == (TABLE_FONT_SIZE_DENSE, "800")


def test_normalize_title() -> None:
    assert _normalize_title("  Продуктовый офис: CORE  ") == "продуктовый офис: core"


def test_section_name_for_sheet() -> None:
    assert _section_name_for_sheet("Продуктовый офис: SMS") == "SMS"
    assert _section_name_for_sheet("Продуктовый офис: VOICE") == "Voice"


def test_template_index_for_sheet_colors() -> None:
    assert _template_index_for_sheet("Продуктовый офис: CORE") == 3
    assert _template_index_for_sheet("Продуктовый офис: M2M / IoT") == 4
    assert _template_index_for_sheet("Продуктовый офис: SMS") == 5
    assert _template_index_for_sheet("Продуктовый офис: VOICE") == 6
    assert _template_index_for_sheet("Продуктовый офис: Перспективные продукты") == 7
    assert _template_index_for_sheet("Продуктовый офис: Продуктовый маркетинг") == 3


def test_mapped_columns_falls_back_to_column_order() -> None:
    columns = ["Месяц", "Направление", "Статус работ", "Комментарий"]
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


def test_estimate_text_lines_wraps_each_paragraph_separately() -> None:
    short_lines = "Первая строка\nВторая строка\nТретья строка"
    assert _estimate_text_lines(short_lines, 40) == 3

    long_paragraph = " ".join(["Фраза с пояснением"] * 18)
    col_chars = _column_chars_per_line(_column_widths(BODY_WIDTH_EMU))
    dense_chars = col_chars[3]
    per_line_wrapping = max(1, (len(long_paragraph) + dense_chars - 1) // dense_chars)
    assert _estimate_text_lines(long_paragraph, dense_chars) == per_line_wrapping


def test_estimate_row_height_uses_dense_column_metrics() -> None:
    columns = ["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"]
    row = {
        "Дата запуска": "июль",
        "Проект": "KATC",
        "Описание проекта": "Короткий статус",
        "Зачем и для чего делаем": (
            "Первая строка пояснения. "
            "Вторая строка пояснения. "
            "Третья строка пояснения. "
            "ориентировочный срок тестирования 15 июня"
        ),
    }
    col_chars = _column_chars_per_line(_column_widths(BODY_WIDTH_EMU))
    height = _estimate_row_height(_row_values(row, columns, 4), col_chars)
    lines = _estimate_text_lines(row["Зачем и для чего делаем"], col_chars[3])
    assert lines <= 4
    assert height < lines * 145000 + 45000


def test_chunk_rows_splits_long_sheet() -> None:
    columns = ["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"]
    rows = [
        {
            "Дата запуска": "01.06",
            "Проект": "CORE",
            "Описание проекта": "Коротко",
            "Зачем и для чего делаем": "OK",
        },
        {
            "Дата запуска": "02.06",
            "Проект": "CORE",
            "Описание проекта": "Очень длинное описание " * 120,
            "Зачем и для чего делаем": "Ещё текст " * 80,
        },
    ]
    chunks = _chunk_rows(rows, columns)
    assert sum(len(chunk) for chunk in chunks) == 2
    assert len(chunks) >= 2


def test_catalog_chunk_plan_keeps_sheet_order() -> None:
    prs = Presentation(str(TEMPLATE_PATH))
    catalog = TemplateCatalog.from_presentation(prs)
    rows = [{"Дата запуска": "01.06", "Проект": "CORE", "Описание проекта": "A", "Зачем и для чего делаем": "B"}]
    chunks = catalog.chunk_plan("Продуктовый офис: CORE", rows, ["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"])
    assert chunks[0][0].index == 3
    assert len(chunks[0][1]) == 1


def test_market_news_lines_formats_rows() -> None:
    sheet = ProductStatusSheetOut(
        gid="0",
        name="Новости",
        columns=["Дата", "Новость", "Описание"],
        rows=[
            {"Дата": "08.06", "Новость": "МТС изменил тариф", "Описание": "Подробности"},
            {"Дата": "", "Новость": "", "Описание": ""},
            {"Дата": "09.06", "Новость": "Yota обновила планы", "Описание": "Стоимость выросла"},
        ],
        totalShown=3,
    )
    assert _market_news_lines(sheet) == [
        "08.06 | МТС изменил тариф | Подробности",
        "09.06 | Yota обновила планы | Стоимость выросла",
    ]


@patch("app.product_status_presentation.load_b2b_news")
@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_fills_market_news_slide(mock_load, mock_news) -> None:
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
    mock_news.return_value = ProductStatusB2BOut(
        title="Новости и запуски",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Новости",
                columns=["Дата", "Новость", "Описание"],
                rows=[
                    {
                        "Дата": "08.06",
                        "Новость": "МТС изменил тариф",
                        "Описание": "Подробности",
                    },
                    {
                        "Дата": "09.06",
                        "Новость": "Yota обновила планы",
                        "Описание": "Стоимость выросла",
                    },
                ],
                totalShown=2,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))
    slide = prs.slides[MARKET_NEWS_SLIDE_INDEX]
    body_texts = [
        shape.text_frame.text
        for shape in slide.shapes
        if shape.has_text_frame and shape.is_placeholder and shape.text_frame.text.strip()
    ]
    assert len(body_texts) == 1
    assert "<$date>" not in body_texts[0]
    assert "08.06 | МТС изменил тариф | Подробности" in body_texts[0]
    assert "09.06 | Yota обновила планы | Стоимость выросла" in body_texts[0]

    body_shape = next(
        shape
        for shape in slide.shapes
        if shape.has_text_frame and shape.is_placeholder and shape.text_frame.text.strip()
    )
    paragraphs = [paragraph.text for paragraph in body_shape.text_frame.paragraphs if paragraph.text.strip()]
    assert len(paragraphs) == 2
    assert paragraphs[0] == "08.06 | МТС изменил тариф | Подробности"
    assert paragraphs[1] == "09.06 | Yota обновила планы | Стоимость выросла"


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_fills_date_and_keeps_fixed_slides(mock_load) -> None:
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

    prs = Presentation(io.BytesIO(content))
    assert len(prs.slides) == FIXED_SLIDE_COUNT + 1

    slide1_text = "".join(shape.text_frame.text for shape in prs.slides[0].shapes if shape.has_text_frame)
    assert "Статус B2B" in slide1_text
    assert DATE_PLACEHOLDER not in slide1_text
    assert re.search(r"\d{2}\.\d{2}\.\d{4}", slide1_text)

    content_slide = prs.slides[FIXED_SLIDE_COUNT]
    title = next(
        shape.text_frame.text
        for shape in content_slide.shapes
        if shape.has_text_frame and shape.is_placeholder
    )
    assert title == "Продуктовый офис: CORE"

    table = next(shape.table for shape in content_slide.shapes if shape.has_table)
    assert table.rows[1].cells[1].text == "CORE"
    assert table.rows[0].cells[0].text == "Дата запуска"


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_uses_colored_templates_per_sheet(mock_load) -> None:
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: CORE",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[{"Дата запуска": "", "Проект": "CORE", "Описание проекта": "A", "Зачем и для чего делаем": "B"}],
                totalShown=1,
            ),
            ProductStatusSheetOut(
                gid="1",
                name="Продуктовый офис: SMS",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[{"Дата запуска": "", "Проект": "SMS Hub", "Описание проекта": "C", "Зачем и для чего делаем": "D"}],
                totalShown=1,
            ),
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))

    core_slide = prs.slides[FIXED_SLIDE_COUNT]
    sms_slide = next(
        prs.slides[index]
        for index in range(FIXED_SLIDE_COUNT, len(prs.slides))
        if any(
            shape.has_text_frame and shape.text_frame.text == "Продуктовый офис: SMS"
            for shape in prs.slides[index].shapes
        )
    )
    core_layout = core_slide.slide_layout.name
    sms_layout = sms_slide.slide_layout.name
    assert core_layout
    assert sms_layout
    assert core_slide.slide_layout == prs.slides[FIXED_SLIDE_COUNT].slide_layout
    assert sms_slide.slide_layout != core_slide.slide_layout


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_colored_text_has_no_highlight_fill(mock_load) -> None:
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: SMS",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[
                    {
                        "Дата запуска": "",
                        "Проект": "[[fg:FF0000::Контроль]]",
                        "Описание проекта": "[[fg:1254CC::hh.ru]] — риск оттока",
                        "Зачем и для чего делаем": "",
                    }
                ],
                totalShown=1,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))
    content_slide = prs.slides[FIXED_SLIDE_COUNT]
    xml = content_slide.part.blob.decode()
    control_start = xml.index("<a:t>Контроль</a:t>")
    control_run = xml[max(0, control_start - 500):control_start + 200]
    assert "val=\"FF0000\"" in control_run
    assert "<a:highlight>" not in control_run

    link_start = xml.index("<a:t>hh.ru</a:t>")
    link_run = xml[max(0, link_start - 500):link_start + 200]
    assert "val=\"1254CC\"" in link_run
    assert "<a:highlight>" not in link_run


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_table_cells_contain_text_xml(mock_load) -> None:
    mock_load.return_value = ProductStatusB2BOut(
        title="Статус продукта B2B",
        sheets=[
            ProductStatusSheetOut(
                gid="0",
                name="Продуктовый офис: CORE",
                columns=["Дата запуска", "Проект", "Описание проекта", "Зачем и для чего делаем"],
                rows=[
                    {
                        "Дата запуска": "09.06",
                        "Проект": "Ремонт",
                        "Описание проекта": "Убираем $300 рублевые офферы$",
                        "Зачем и для чего делаем": "В работе",
                    }
                ],
                totalShown=1,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))
    content_slide = prs.slides[FIXED_SLIDE_COUNT]
    title = next(
        shape.text_frame.text
        for shape in content_slide.shapes
        if shape.is_placeholder and shape.has_text_frame
    )
    table = next(shape.table for shape in content_slide.shapes if shape.has_table)
    assert table.rows[1].cells[1].text == "Ремонт"
    assert table.rows[0].cells[0].text == "Дата запуска"
    xml = content_slide.part.blob.decode()

    assert "<a:t>Ремонт</a:t>" in xml
    assert "<a:t>300 рублевые офферы</a:t>" in xml
    assert "<a:highlight>" in xml or "strike=" in xml
    assert 'srgbClr val="FFFFFF"' in xml
    assert 'srgbClr val="7F7F7F"' in xml
    assert "tableStyleId" not in xml.split("<a:tbl>")[1].split("</a:tbl>")[0]
    assert title == "Продуктовый офис: CORE"


@patch("app.product_status_presentation.load_b2b_product_status")
def test_generate_presentation_splits_rows_across_slides(mock_load) -> None:
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
                        "Описание проекта": "Коротко",
                        "Зачем и для чего делаем": "OK",
                    },
                    {
                        "Дата запуска": "02.06",
                        "Проект": "CORE",
                        "Описание проекта": "Очень длинное описание " * 120,
                        "Зачем и для чего делаем": "Ещё текст " * 80,
                    },
                ],
                totalShown=2,
            )
        ],
    )

    content, _ = generate_b2b_product_status_presentation()
    prs = Presentation(io.BytesIO(content))
    core_slides = [
        prs.slides[index]
        for index in range(FIXED_SLIDE_COUNT, len(prs.slides))
        if any(
            shape.has_text_frame and shape.text_frame.text == "Продуктовый офис: CORE"
            for shape in prs.slides[index].shapes
        )
    ]
    assert len(core_slides) >= 2
