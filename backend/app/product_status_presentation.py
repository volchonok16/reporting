from __future__ import annotations

import io
import logging
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Pt

from app.config import settings
from app.product_status_service import load_b2b_product_status
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

ROWS_PER_SLIDE = 6
MOSCOW_TZ = ZoneInfo("Europe/Moscow")


def _template_path() -> Path:
    configured = settings.b2b_product_status_presentation_template.strip()
    if configured:
        path = Path(configured)
        if path.is_file():
            return path
        logger.warning("product_status_template_missing path=%s", configured)

    default = Path(__file__).resolve().parent.parent / "assets" / "b2b_product_status_template.pptx"
    if default.is_file():
        return default

    raise HTTPException(
        status_code=503,
        detail="Шаблон презентации статуса продукта B2B не найден.",
    )


def _delete_slide(prs: Presentation, index: int) -> None:
    slide_ids = prs.slides._sldIdLst
    slide_id = slide_ids[index]
    r_id = slide_id.rId
    prs.part.drop_rel(r_id)
    slide_ids.remove(slide_id)


def _duplicate_slide(prs: Presentation, slide_index: int):
    template = prs.slides[slide_index]
    new_slide = prs.slides.add_slide(template.slide_layout)
    for shape in template.shapes:
        new_element = deepcopy(shape.element)
        new_slide.shapes._spTree.insert_element_before(new_element, "p:extLst")
    return new_slide


def _chunk_rows(rows: list[dict[str, str]], size: int) -> list[list[dict[str, str]]]:
    if not rows:
        return [[]]
    return [rows[index : index + size] for index in range(0, len(rows), size)]


def _font_size_for_text(text: str, *, header: bool = False) -> Pt:
    length = len(text.strip())
    if header:
        return Pt(11 if length > 28 else 12)
    if length > 320:
        return Pt(8)
    if length > 180:
        return Pt(9)
    if length > 90:
        return Pt(10)
    return Pt(11)


def _set_cell_text(cell, text: str, *, header: bool = False, bold: bool = False) -> None:
    value = (text or "").strip() or "—"
    frame = cell.text_frame
    frame.clear()
    paragraph = frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.LEFT
    run = paragraph.add_run()
    run.text = value
    run.font.size = _font_size_for_text(value, header=header)
    run.font.bold = bold or header
    run.font.name = "Arial"
    run.font.color.rgb = RGBColor(0x00, 0x00, 0x00)


def _find_title_shape(slide):
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        if "заголовок" in shape.name.lower():
            return shape
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip():
            return shape
    return None


def _find_table_shape(slide):
    best = None
    best_area = 0
    for shape in slide.shapes:
        if not shape.has_table:
            continue
        area = shape.width * shape.height
        if area > best_area:
            best = shape
            best_area = area
    return best.table if best is not None else None


def _build_slide_title(sheet_name: str, page: int, total_pages: int) -> str:
    if total_pages > 1:
        return f"{sheet_name} ({page}/{total_pages})"
    return sheet_name


def _fill_content_slide(
    slide,
    *,
    sheet_name: str,
    columns: list[str],
    rows: list[dict[str, str]],
    page: int,
    total_pages: int,
    generated_at: datetime,
    show_header: bool,
) -> None:
    title_shape = _find_title_shape(slide)
    if title_shape is not None:
        title_shape.text_frame.clear()
        title_paragraph = title_shape.text_frame.paragraphs[0]
        title_run = title_paragraph.add_run()
        title_run.text = _build_slide_title(sheet_name, page, total_pages)
        title_run.font.size = Pt(24)
        title_run.font.bold = True
        title_run.font.name = "Arial"

        status_paragraph = title_shape.text_frame.add_paragraph()
        status_run = status_paragraph.add_run()
        status_run.text = f"Статус на {generated_at.strftime('%d.%m.%Y %H:%M')} (МСК)"
        status_run.font.size = Pt(10)
        status_run.font.name = "Arial"
        status_run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    table = _find_table_shape(slide)
    if table is None:
        return

    col_count = len(table.columns)
    usable_columns = columns[:col_count]
    if len(usable_columns) < col_count:
        usable_columns = usable_columns + [""] * (col_count - len(usable_columns))

    row_offset = 0
    if show_header and len(table.rows) > 0:
        header_row = table.rows[0]
        for col_index in range(col_count):
            _set_cell_text(
                header_row.cells[col_index],
                usable_columns[col_index],
                header=True,
                bold=True,
            )
        row_offset = 1

    data_capacity = max(0, len(table.rows) - row_offset)
    for data_index in range(data_capacity):
        row = rows[data_index] if data_index < len(rows) else None
        table_row = table.rows[row_offset + data_index]
        for col_index in range(col_count):
            column_name = usable_columns[col_index]
            value = row.get(column_name, "") if row is not None else ""
            _set_cell_text(table_row.cells[col_index], value)


def _build_slide_specs(data: ProductStatusB2BOut) -> list[tuple[ProductStatusSheetOut, list[dict[str, str]], int, int]]:
    specs: list[tuple[ProductStatusSheetOut, list[dict[str, str]], int, int]] = []
    for sheet in data.sheets:
        chunks = _chunk_rows(sheet.rows, ROWS_PER_SLIDE)
        total_pages = len(chunks)
        for page_index, chunk in enumerate(chunks, start=1):
            specs.append((sheet, chunk, page_index, total_pages))
    return specs


def generate_b2b_product_status_presentation() -> tuple[bytes, str]:
    data = load_b2b_product_status()
    specs = _build_slide_specs(data)
    if not specs:
        raise HTTPException(
            status_code=502,
            detail="Нет данных для формирования презентации.",
        )

    template_path = _template_path()
    prs = Presentation(str(template_path))
    if len(prs.slides) < 2:
        raise HTTPException(
            status_code=503,
            detail="В шаблоне презентации должны быть титульный и контентный слайды.",
        )

    generated_at = datetime.now(MOSCOW_TZ)

    while len(prs.slides) > 2:
        _delete_slide(prs, len(prs.slides) - 1)

    while len(prs.slides) < len(specs) + 1:
        _duplicate_slide(prs, 1)

    for index, (sheet, chunk, page, total_pages) in enumerate(specs):
        slide = prs.slides[index + 1]
        _fill_content_slide(
            slide,
            sheet_name=sheet.name,
            columns=sheet.columns,
            rows=chunk,
            page=page,
            total_pages=total_pages,
            generated_at=generated_at,
            show_header=page == 1,
        )

    buffer = io.BytesIO()
    prs.save(buffer)
    filename = f"status-produkta-b2b-{generated_at.strftime('%Y%m%d')}.pptx"
    return buffer.getvalue(), filename
