from __future__ import annotations

import io
import logging
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Pt

from app.config import settings
from app.product_status_service import load_b2b_product_status
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

MOSCOW_TZ = ZoneInfo("Europe/Moscow")
_CNVPR_TAGS = (
    "{http://schemas.openxmlformats.org/presentationml/2006/main}cNvPr",
    "{http://schemas.openxmlformats.org/drawingml/2006/main}cNvPr",
)


@dataclass(frozen=True)
class ContentSlideTemplate:
    index: int
    title: str
    row_count: int
    column_count: int


class TemplateCatalog:
    """Слайды-образцы из PPTX: заголовок → список макетов с разной вместимостью таблицы."""

    def __init__(
        self,
        *,
        title_slide_index: int,
        templates: list[ContentSlideTemplate],
    ) -> None:
        self.title_slide_index = title_slide_index
        self._templates = templates
        self._by_title: dict[str, list[ContentSlideTemplate]] = {}
        for template in templates:
            key = _normalize_title(template.title)
            self._by_title.setdefault(key, []).append(template)
        for key in self._by_title:
            self._by_title[key].sort(key=lambda item: item.index)

        self._default = self._pick_default_template()

    @classmethod
    def from_presentation(cls, prs: Presentation) -> TemplateCatalog:
        if len(prs.slides) < 2:
            raise HTTPException(
                status_code=503,
                detail="В шаблоне презентации должны быть титульный и контентный слайды.",
            )

        templates: list[ContentSlideTemplate] = []
        for index, slide in enumerate(prs.slides):
            title = _slide_title(slide)
            table = _find_table_shape(slide)
            if not title or table is None:
                continue
            templates.append(
                ContentSlideTemplate(
                    index=index,
                    title=title,
                    row_count=len(table.rows),
                    column_count=len(table.columns),
                )
            )

        if not templates:
            raise HTTPException(
                status_code=503,
                detail="В шаблоне не найдено контентных слайдов с заголовком и таблицей.",
            )

        title_slide_index = 0 if _find_table_shape(prs.slides[0]) else templates[0].index
        return cls(title_slide_index=title_slide_index, templates=templates)

    def match(self, sheet_name: str) -> list[ContentSlideTemplate]:
        normalized = _normalize_title(sheet_name)
        if normalized in self._by_title:
            return list(self._by_title[normalized])

        for key, items in self._by_title.items():
            if normalized in key or key in normalized:
                return list(items)

        return []

    def blueprint_for(self, sheet_name: str, *, rows_needed: int) -> ContentSlideTemplate:
        matched = self.match(sheet_name)
        pool = matched if matched else [self._default]

        fitting = [item for item in pool if item.row_count >= rows_needed]
        if fitting:
            return min(fitting, key=lambda item: (item.row_count, item.index))

        return max(pool, key=lambda item: item.row_count)

    def chunk_plan(
        self,
        sheet_name: str,
        rows: list[dict[str, str]],
    ) -> list[tuple[ContentSlideTemplate, list[dict[str, str]]]]:
        if not rows:
            template = self.blueprint_for(sheet_name, rows_needed=1)
            return [(template, [])]

        matched = self.match(sheet_name)
        pool = matched if matched else [self._default]
        default_capacity = max(item.row_count for item in pool)

        chunks: list[tuple[ContentSlideTemplate, list[dict[str, str]]]] = []
        offset = 0
        while offset < len(rows):
            remaining = len(rows) - offset
            take = min(remaining, default_capacity)
            template = self.blueprint_for(sheet_name, rows_needed=take)
            chunk = rows[offset : offset + take]
            chunks.append((template, chunk))
            offset += take
        return chunks

    def _pick_default_template(self) -> ContentSlideTemplate:
        if not self._templates:
            raise HTTPException(
                status_code=503,
                detail="В шаблоне не найдено контентных слайдов.",
            )
        return max(self._templates, key=lambda item: (item.row_count, -item.index))


def _normalize_title(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().casefold())


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


def _blank_layout(prs: Presentation):
    return min(prs.slide_layouts, key=lambda layout: len(layout.placeholders))


def _max_shape_id(slide) -> int:
    max_id = 1
    for shape in slide.shapes:
        shape_id = getattr(shape, "shape_id", None)
        if isinstance(shape_id, int):
            max_id = max(max_id, shape_id)
    return max_id


def _renumber_shape_ids(element, start_id: int) -> int:
    current = start_id
    for tag in _CNVPR_TAGS:
        for node in element.iter(tag):
            current += 1
            node.set("id", str(current))
    return current


def _duplicate_slide_safe(prs: Presentation, source_slide):
    """Копирует слайд без think-cell OLE и с уникальными id фигур."""
    dest = prs.slides.add_slide(_blank_layout(prs))

    for shape in list(dest.shapes):
        dest.shapes._spTree.remove(shape._element)

    next_id = _max_shape_id(dest)
    for shape in source_slide.shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT:
            continue
        new_element = deepcopy(shape.element)
        next_id = _renumber_shape_ids(new_element, next_id)
        dest.shapes._spTree.insert_element_before(new_element, "p:extLst")

    return dest


def _allocate_slides(
    catalog: TemplateCatalog,
    specs: list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]],
    *,
    slide_count: int,
) -> tuple[list[tuple[int, ProductStatusSheetOut, list[dict[str, str]]]], list[tuple[int, ProductStatusSheetOut, list[dict[str, str]]]]]:
    """Возвращает (in-place, overflow) — overflow требует безопасного дублирования."""
    title_idx = catalog.title_slide_index
    used: set[int] = {title_idx}
    in_place: list[tuple[int, ProductStatusSheetOut, list[dict[str, str]]]] = []
    overflow: list[tuple[int, ProductStatusSheetOut, list[dict[str, str]]]] = []

    all_indices = [index for index in range(slide_count) if index != title_idx]

    for sheet, template, chunk in specs:
        matched = [
            item.index
            for item in catalog.match(sheet.name)
            if item.index not in used
        ]
        general = [index for index in all_indices if index not in used]

        if matched:
            slide_index = matched[0]
        elif general:
            slide_index = general[0]
        else:
            overflow.append((template.index, sheet, chunk))
            continue

        used.add(slide_index)
        in_place.append((slide_index, sheet, chunk))

    return in_place, overflow


def _slide_title(slide) -> str | None:
    title_shape = _find_title_shape(slide)
    if title_shape is None:
        return None
    text = title_shape.text_frame.text.strip()
    if not text:
        return None
    return text.split("\n")[0].strip()


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


def _first_run_font(run) -> tuple[str | None, int | None, bool | None]:
    return (
        run.font.name,
        run.font.size,
        run.font.bold,
    )


def _cell_font_defaults(cell) -> tuple[str | None, int | None, bool | None]:
    for paragraph in cell.text_frame.paragraphs:
        for run in paragraph.runs:
            if run.text.strip():
                return _first_run_font(run)
    for paragraph in cell.text_frame.paragraphs:
        if paragraph.runs:
            return _first_run_font(paragraph.runs[0])
    return None, None, None


def _font_size_for_text(text: str, base_size: int | None) -> int | None:
    length = len(text.strip())
    if base_size is None:
        return None
    if length > 320:
        return max(int(base_size * 0.75), 72000)
    if length > 180:
        return max(int(base_size * 0.85), 80000)
    if length > 90:
        return max(int(base_size * 0.92), 90000)
    return base_size


def _set_run_font(run, *, name: str | None, size: int | None, bold: bool | None) -> None:
    if name:
        run.font.name = name
    if size:
        run.font.size = size
    if bold is not None:
        run.font.bold = bold
    run.font.color.rgb = RGBColor(0x00, 0x00, 0x00)


def _replace_cell_text(cell, text: str) -> None:
    value = (text or "").strip()
    font_name, font_size, font_bold = _cell_font_defaults(cell)
    adjusted_size = _font_size_for_text(value, font_size)

    frame = cell.text_frame
    frame.clear()
    paragraph = frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.LEFT
    run = paragraph.add_run()
    run.text = value
    _set_run_font(run, name=font_name, size=adjusted_size, bold=font_bold)


def _replace_title(title_shape, sheet_name: str) -> None:
    font_name = None
    font_size = None
    font_bold = None
    for paragraph in title_shape.text_frame.paragraphs:
        for run in paragraph.runs:
            if run.text.strip():
                font_name, font_size, font_bold = _first_run_font(run)
                break
        if font_name:
            break

    title_shape.text_frame.clear()
    paragraph = title_shape.text_frame.paragraphs[0]
    run = paragraph.add_run()
    run.text = sheet_name
    _set_run_font(
        run,
        name=font_name or "T2 Halvar Breit ExtraBold",
        size=font_size or Pt(32),
        bold=font_bold,
    )


def _row_values(row: dict[str, str], columns: list[str], col_count: int) -> list[str]:
    values = [(row.get(column) or "").strip() for column in columns[:col_count]]
    if len(values) < col_count:
        values.extend([""] * (col_count - len(values)))
    return values


def _fill_content_slide(
    slide,
    *,
    sheet_name: str,
    columns: list[str],
    rows: list[dict[str, str]],
) -> None:
    title_shape = _find_title_shape(slide)
    if title_shape is not None:
        _replace_title(title_shape, sheet_name)

    table = _find_table_shape(slide)
    if table is None:
        return

    col_count = len(table.columns)
    for row_index in range(len(table.rows)):
        if row_index < len(rows):
            values = _row_values(rows[row_index], columns, col_count)
        else:
            values = [""] * col_count
        table_row = table.rows[row_index]
        for col_index in range(col_count):
            value = values[col_index] if col_index < len(values) else ""
            _replace_cell_text(table_row.cells[col_index], value)


def _build_slide_specs(
    data: ProductStatusB2BOut,
    catalog: TemplateCatalog,
) -> list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]]:
    specs: list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]] = []
    for sheet in data.sheets:
        for template, chunk in catalog.chunk_plan(sheet.name, sheet.rows):
            specs.append((sheet, template, chunk))
    return specs


def generate_b2b_product_status_presentation() -> tuple[bytes, str]:
    data = load_b2b_product_status()

    template_path = _template_path()
    source_prs = Presentation(str(template_path))
    output_prs = Presentation(str(template_path))
    catalog = TemplateCatalog.from_presentation(source_prs)
    specs = _build_slide_specs(data, catalog)
    if not specs:
        raise HTTPException(
            status_code=502,
            detail="Нет данных для формирования презентации.",
        )

    generated_at = datetime.now(MOSCOW_TZ)
    title_idx = catalog.title_slide_index
    in_place, overflow = _allocate_slides(
        catalog,
        specs,
        slide_count=len(source_prs.slides),
    )

    used_indices = {title_idx, *(index for index, _, _ in in_place)}

    for slide_index, sheet, chunk in in_place:
        _fill_content_slide(
            output_prs.slides[slide_index],
            sheet_name=sheet.name,
            columns=sheet.columns,
            rows=chunk,
        )

    for index in range(len(output_prs.slides) - 1, -1, -1):
        if index not in used_indices:
            _delete_slide(output_prs, index)

    for template_index, sheet, chunk in overflow:
        source_slide = source_prs.slides[template_index]
        new_slide = _duplicate_slide_safe(output_prs, source_slide)
        _fill_content_slide(
            new_slide,
            sheet_name=sheet.name,
            columns=sheet.columns,
            rows=chunk,
        )

    buffer = io.BytesIO()
    output_prs.save(buffer)
    filename = f"status-produkta-b2b-{generated_at.strftime('%Y%m%d')}.pptx"
    return buffer.getvalue(), filename
