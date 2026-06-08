from __future__ import annotations

import io
import logging
import re
from copy import deepcopy
from datetime import date
from pathlib import Path

from fastapi import HTTPException
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.enum.text import PP_ALIGN
from pptx.util import Pt

from app.config import settings
from app.product_status_service import load_b2b_product_status
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

MAX_DATA_ROWS_PER_SLIDE = 6
MAX_COLUMNS = 4
_STATUS_COLUMN_PATTERN = re.compile(r"^статус$", re.IGNORECASE)
_ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
_DEFAULT_TEMPLATE = _ASSETS_DIR / "b2b_product_status_template.pptx"
_CONTENT_TEMPLATE_SLIDE_INDEX = 1


def template_path() -> Path:
    configured = settings.b2b_product_status_presentation_template.strip()
    if configured:
        path = Path(configured)
        if path.is_file():
            return path
        logger.warning(
            "product_status_presentation_template_missing path=%s",
            configured,
        )
    if _DEFAULT_TEMPLATE.is_file():
        return _DEFAULT_TEMPLATE
    raise HTTPException(
        status_code=503,
        detail="Шаблон презентации статуса продукта B2B не найден.",
    )


def select_columns(columns: list[str]) -> list[str]:
    if len(columns) <= MAX_COLUMNS:
        return columns

    status_index = next(
        (
            index
            for index, column in enumerate(columns)
            if _STATUS_COLUMN_PATTERN.match(column.strip())
        ),
        None,
    )
    selected = columns[:MAX_COLUMNS]
    if status_index is not None and status_index >= MAX_COLUMNS:
        selected[-1] = columns[status_index]
    return selected


def chunk_rows(
    rows: list[dict[str, str]],
    size: int,
) -> list[list[dict[str, str]]]:
    if not rows:
        return [[]]
    return [rows[index:index + size] for index in range(0, len(rows), size)]


def _delete_slide(prs: Presentation, index: int) -> None:
    slide_id_list = prs.slides._sldIdLst
    relationship_id = slide_id_list[index].rId
    prs.part.drop_rel(relationship_id)
    del slide_id_list[index]


def _duplicate_slide(prs: Presentation, index: int):
    source = prs.slides[index]
    copied = prs.slides.add_slide(source.slide_layout)
    for shape in source.shapes:
        copied.shapes._spTree.insert_element_before(
            deepcopy(shape.element),
            "p:extLst",
        )
    return copied


def _find_title_shape(slide):
    for shape in slide.shapes:
        if (
            shape.is_placeholder
            and shape.placeholder_format.type == PP_PLACEHOLDER.TITLE
        ):
            return shape
        if hasattr(shape, "text") and shape.name.startswith("Заголовок"):
            return shape
    return None


def _find_table_shape(slide):
    for shape in slide.shapes:
        if shape.has_table:
            return shape
    return None


def _set_cell_text(cell, text: str, *, font_size: Pt) -> None:
    value = (text or "").strip() or "—"
    cell.text = value
    cell.text_frame.word_wrap = True
    for paragraph in cell.text_frame.paragraphs:
        paragraph.alignment = PP_ALIGN.LEFT
        for run in paragraph.runs:
            run.font.size = font_size
            run.font.name = "Arial"
            run.font.color.rgb = RGBColor(0, 0, 0)


def _font_size_for_sheet(columns: list[str], rows: list[dict[str, str]]) -> Pt:
    if not rows:
        return Pt(11)

    selected = select_columns(columns)
    lengths: list[int] = []
    for row in rows:
        for column in selected:
            lengths.append(len((row.get(column) or "").strip()))

    average = sum(lengths) / max(len(lengths), 1)
    size = 11
    if len(selected) >= 4:
        size -= 1
    if average > 100:
        size -= 1
    if average > 180:
        size -= 1
    return Pt(max(8, size))


def _slide_title(sheet_name: str, page_index: int, page_count: int) -> str:
    if page_count <= 1:
        return sheet_name
    return f"{sheet_name} ({page_index}/{page_count})"


def _fill_table(
    table,
    *,
    columns: list[str],
    rows: list[dict[str, str]],
    include_header: bool,
    font_size: Pt,
) -> None:
    selected_columns = select_columns(columns)
    row_offset = 0

    if include_header:
        for column_index in range(len(table.columns)):
            if column_index < len(selected_columns):
                header = selected_columns[column_index]
            else:
                header = ""
            _set_cell_text(
                table.cell(0, column_index),
                header,
                font_size=font_size,
            )
        row_offset = 1

    for data_index in range(MAX_DATA_ROWS_PER_SLIDE):
        table_row_index = row_offset + data_index
        if table_row_index >= len(table.rows):
            break

        if data_index < len(rows):
            row = rows[data_index]
            for column_index in range(len(table.columns)):
                if column_index < len(selected_columns):
                    value = row.get(selected_columns[column_index], "")
                else:
                    value = ""
                _set_cell_text(
                    table.cell(table_row_index, column_index),
                    value,
                    font_size=font_size,
                )
        else:
            for column_index in range(len(table.columns)):
                _set_cell_text(
                    table.cell(table_row_index, column_index),
                    "",
                    font_size=font_size,
                )


def _append_sheet_slides(
    prs: Presentation,
    *,
    template_slide_index: int,
    sheet: ProductStatusSheetOut,
) -> None:
    row_chunks = chunk_rows(sheet.rows, MAX_DATA_ROWS_PER_SLIDE)
    page_count = len(row_chunks)
    font_size = _font_size_for_sheet(sheet.columns, sheet.rows)

    for page_index, chunk in enumerate(row_chunks, start=1):
        slide = _duplicate_slide(prs, template_slide_index)
        title_shape = _find_title_shape(slide)
        if title_shape is not None:
            title_shape.text = _slide_title(sheet.name, page_index, page_count)

        table_shape = _find_table_shape(slide)
        if table_shape is None:
            continue

        _fill_table(
            table_shape.table,
            columns=sheet.columns,
            rows=chunk,
            include_header=True,
            font_size=font_size,
        )


def build_b2b_product_status_presentation(data: ProductStatusB2BOut) -> bytes:
    path = template_path()
    prs = Presentation(str(path))

    if len(prs.slides) <= _CONTENT_TEMPLATE_SLIDE_INDEX:
        raise HTTPException(
            status_code=503,
            detail="В шаблоне презентации нет слайда с таблицей.",
        )

    while len(prs.slides) > _CONTENT_TEMPLATE_SLIDE_INDEX + 1:
        _delete_slide(prs, _CONTENT_TEMPLATE_SLIDE_INDEX + 1)

    for sheet in data.sheets:
        _append_sheet_slides(
            prs,
            template_slide_index=_CONTENT_TEMPLATE_SLIDE_INDEX,
            sheet=sheet,
        )

    _delete_slide(prs, _CONTENT_TEMPLATE_SLIDE_INDEX)

    buffer = io.BytesIO()
    prs.save(buffer)
    return buffer.getvalue()


def presentation_filename(generated_on: date | None = None) -> str:
    day = generated_on or date.today()
    return f"status-b2b-{day.strftime('%d%m%Y')}.pptx"


def generate_b2b_product_status_presentation() -> tuple[bytes, str]:
    data = load_b2b_product_status()
    content = build_b2b_product_status_presentation(data)
    return content, presentation_filename()
