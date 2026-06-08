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
from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN, MSO_VERTICAL_ANCHOR
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
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

TITLE_FONT_NAME = "T2 Halvar Breit ExtraBold"
TITLE_FONT_SIZE = Pt(32)
TITLE_FONT_SZ_XML = "3200"
TABLE_FONT_NAME = "T2 Rooftop"
TABLE_FONT_SIZE = Pt(10)
TABLE_FONT_SZ_XML = "1000"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
LINE_HEIGHT_EMU = 145000
MIN_ROW_HEIGHT_EMU = 396000
ROW_PADDING_EMU = 50000
CHAR_WIDTH_EMU = 76000
HEIGHT_SAFETY_RATIO = 0.82
MAX_ROWS_PER_SLIDE = 5
LONG_CELL_CHARS = 180


@dataclass(frozen=True)
class ContentSlideTemplate:
    index: int
    title: str
    row_count: int
    column_count: int
    table_height: int
    col_chars_per_line: tuple[int, ...]


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
            table_shape, table = _find_table(slide)
            if not title or table is None or table_shape is None:
                continue
            templates.append(
                ContentSlideTemplate(
                    index=index,
                    title=title,
                    row_count=len(table.rows),
                    column_count=len(table.columns),
                    table_height=int(table_shape.height),
                    col_chars_per_line=_column_chars_per_line(table),
                )
            )

        if not templates:
            raise HTTPException(
                status_code=503,
                detail="В шаблоне не найдено контентных слайдов с заголовком и таблицей.",
            )

        title_slide_index = 0 if _find_table(prs.slides[0])[1] is not None else templates[0].index
        return cls(title_slide_index=title_slide_index, templates=templates)

    def match(self, sheet_name: str) -> list[ContentSlideTemplate]:
        normalized = _normalize_title(sheet_name)
        if normalized in self._by_title:
            return list(self._by_title[normalized])

        for key, items in self._by_title.items():
            if normalized in key or key in normalized:
                return list(items)

        return []

    def template_pool(self, sheet_name: str) -> list[ContentSlideTemplate]:
        matched = self.match(sheet_name)
        return matched if matched else [self._default]

    def chunk_plan(
        self,
        sheet_name: str,
        rows: list[dict[str, str]],
        columns: list[str],
    ) -> list[tuple[ContentSlideTemplate, list[dict[str, str]]]]:
        pool = self.template_pool(sheet_name)
        if not rows:
            return [(pool[0], [])]

        primary = pool[0]
        max_table_height = int(primary.table_height * HEIGHT_SAFETY_RATIO)
        col_chars = primary.col_chars_per_line
        avg_row_height = max(MIN_ROW_HEIGHT_EMU, primary.table_height // max(primary.row_count, 1))

        chunks: list[tuple[ContentSlideTemplate, list[dict[str, str]]]] = []
        current_chunk: list[dict[str, str]] = []
        current_height = 0

        for row in rows:
            values = _row_values(row, columns, len(col_chars))
            row_height = _estimate_row_height(values, col_chars)
            row_is_heavy = _row_is_heavy(values)

            should_split = bool(current_chunk) and (
                current_height + row_height > max_table_height
                or len(current_chunk) >= MAX_ROWS_PER_SLIDE
                or (row_is_heavy and len(current_chunk) >= max(1, MAX_ROWS_PER_SLIDE - 1))
                or (
                    row_height > avg_row_height * 1.15
                    and current_height + row_height > avg_row_height * 2.5
                )
            )

            if should_split:
                chunks.append((self._pick_template_for_chunk(pool, len(current_chunk)), current_chunk))
                current_chunk = []
                current_height = 0

            current_chunk.append(row)
            current_height += row_height

        if current_chunk:
            chunks.append((self._pick_template_for_chunk(pool, len(current_chunk)), current_chunk))

        return chunks

    def _pick_template_for_chunk(
        self,
        pool: list[ContentSlideTemplate],
        row_count: int,
    ) -> ContentSlideTemplate:
        fitting = [item for item in pool if item.row_count >= row_count]
        if fitting:
            return min(fitting, key=lambda item: (item.row_count, item.index))
        return max(pool, key=lambda item: item.row_count)

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


def _column_chars_per_line(table) -> tuple[int, ...]:
    return tuple(
        max(8, int(table.columns[index].width / CHAR_WIDTH_EMU))
        for index in range(len(table.columns))
    )


def _row_is_heavy(values: list[str]) -> bool:
    return any(len(_sanitize_cell_text(value)) > LONG_CELL_CHARS for value in values[2:4])


def _estimate_row_height(values: list[str], col_chars_per_line: tuple[int, ...]) -> int:
    max_lines = 1
    for index, text in enumerate(values):
        cleaned = _sanitize_cell_text(text)
        if not cleaned:
            continue
        chars_per_line = col_chars_per_line[index] if index < len(col_chars_per_line) else 40
        explicit_lines = cleaned.count("\n") + 1
        wrapped_lines = max(1, (len(cleaned) + chars_per_line - 1) // chars_per_line)
        max_lines = max(max_lines, explicit_lines, wrapped_lines)

    return max(MIN_ROW_HEIGHT_EMU, max_lines * LINE_HEIGHT_EMU + ROW_PADDING_EMU)


def _find_table(slide):
    best = None
    best_area = 0
    for shape in slide.shapes:
        if not shape.has_table:
            continue
        area = shape.width * shape.height
        if area > best_area:
            best = shape
            best_area = area
    if best is None:
        return None, None
    return best, best.table


def _find_table_shape(slide):
    _, table = _find_table(slide)
    return table


def _set_run_font(
    run,
    *,
    name: str,
    size: Pt,
    bold: bool = False,
) -> None:
    run.font.name = name
    run.font.size = size
    run.font.bold = bold
    run.font.color.rgb = RGBColor(0x00, 0x00, 0x00)


def _set_paragraph_font(
    paragraph,
    *,
    name: str,
    size: Pt,
    bold: bool = False,
) -> None:
    paragraph.font.name = name
    paragraph.font.size = size
    paragraph.font.bold = bold
    paragraph.font.color.rgb = RGBColor(0x00, 0x00, 0x00)


def _apply_text_frame_style(
    frame,
    *,
    font_name: str,
    font_size: Pt,
    bold: bool,
) -> None:
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.vertical_anchor = MSO_VERTICAL_ANCHOR.TOP
    frame.margin_left = Pt(2)
    frame.margin_right = Pt(2)
    frame.margin_top = Pt(2)
    frame.margin_bottom = Pt(2)

    for paragraph in frame.paragraphs:
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.space_after = Pt(0)
        paragraph.space_before = Pt(0)
        paragraph.level = 0
        _set_paragraph_font(paragraph, name=font_name, size=font_size, bold=bold)
        for run in paragraph.runs:
            _set_run_font(run, name=font_name, size=font_size, bold=bold)


def _clean_line_text(line: str) -> str:
    cleaned = line.strip()
    while cleaned.startswith(("•", "●", "▪", "◦", "‣")):
        cleaned = cleaned[1:].lstrip()
    return cleaned


def _sanitize_cell_text(text: str) -> str:
    cleaned = (text or "").replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [_clean_line_text(line) for line in cleaned.split("\n")]
    return "\n".join(lines).strip()


def _set_xml_solid_black(rpr_element) -> None:
    for child in list(rpr_element):
        if child.tag == qn("a:solidFill"):
            rpr_element.remove(child)
    rpr_element.insert(
        0,
        parse_xml(f'<a:solidFill xmlns:a="{A_NS}"><a:srgbClr val="000000"/></a:solidFill>'),
    )


def _set_xml_latin_typeface(rpr_element, font_name: str) -> None:
    latin = rpr_element.find(qn("a:latin"))
    if latin is None:
        latin = parse_xml(f'<a:latin xmlns:a="{A_NS}" typeface="{font_name}"/>')
        rpr_element.append(latin)
    else:
        latin.set("typeface", font_name)


def _normalize_tx_body_element(
    tx_body,
    *,
    font_name: str,
    font_sz: str,
) -> None:
    if tx_body is None:
        return

    body_pr = tx_body.find(qn("a:bodyPr"))
    if body_pr is not None:
        body_pr.set("wrap", "square")
        for autofit_tag in ("normAutofit", "spAutoFit"):
            autofit = body_pr.find(qn(f"a:{autofit_tag}"))
            if autofit is not None:
                body_pr.remove(autofit)

    for paragraph_props in tx_body.findall(".//" + qn("a:pPr")):
        for bullet_tag in ("buChar", "buAutoNum", "buBlip", "buFont"):
            for bullet_node in paragraph_props.findall(qn(f"a:{bullet_tag}")):
                paragraph_props.remove(bullet_node)
        if paragraph_props.find(qn("a:buNone")) is None:
            paragraph_props.insert(0, parse_xml(f'<a:buNone xmlns:a="{A_NS}"/>'))
        paragraph_props.set("lvl", "0")

    for prop_tag in ("a:rPr", "a:endParaRPr", "a:defRPr"):
        for props in tx_body.findall(".//" + qn(prop_tag)):
            props.set("sz", font_sz)
            props.set("dirty", "0")
            _set_xml_latin_typeface(props, font_name)
            _set_xml_solid_black(props)


def _normalize_cell_xml(cell, *, font_name: str, font_sz: str) -> None:
    _normalize_tx_body_element(cell._tc.txBody, font_name=font_name, font_sz=font_sz)


def _normalize_text_frame_xml(frame, *, font_name: str, font_sz: str) -> None:
    _normalize_tx_body_element(frame._txBody, font_name=font_name, font_sz=font_sz)


def _resize_table_rows(table, data_rows: int, *, target_height: int | None = None) -> None:
    row_count = len(table.rows)
    if data_rows <= 0 or row_count == 0:
        return

    total_height = target_height if target_height is not None else sum(int(row.height) for row in table.rows)
    if data_rows >= row_count:
        per_row = max(MIN_ROW_HEIGHT_EMU, total_height // row_count)
        for row in table.rows:
            row.height = per_row
        return

    spare_rows = row_count - data_rows
    empty_total = MIN_ROW_HEIGHT_EMU * spare_rows
    data_total = max(MIN_ROW_HEIGHT_EMU * data_rows, total_height - empty_total)
    per_data = data_total // data_rows

    for index, row in enumerate(table.rows):
        row.height = per_data if index < data_rows else MIN_ROW_HEIGHT_EMU


def _replace_cell_text(cell, text: str) -> None:
    value = _sanitize_cell_text(text)
    frame = cell.text_frame
    frame.clear()
    _apply_text_frame_style(
        frame,
        font_name=TABLE_FONT_NAME,
        font_size=TABLE_FONT_SIZE,
        bold=False,
    )

    lines = value.split("\n") if value else [""]
    for line_index, line in enumerate(lines):
        paragraph = frame.paragraphs[0] if line_index == 0 else frame.add_paragraph()
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.space_after = Pt(0)
        paragraph.space_before = Pt(0)
        paragraph.level = 0
        _set_paragraph_font(
            paragraph,
            name=TABLE_FONT_NAME,
            size=TABLE_FONT_SIZE,
            bold=False,
        )
        run = paragraph.add_run()
        run.text = line
        _set_run_font(run, name=TABLE_FONT_NAME, size=TABLE_FONT_SIZE, bold=False)

    _normalize_cell_xml(cell, font_name=TABLE_FONT_NAME, font_sz=TABLE_FONT_SZ_XML)


def _replace_title(title_shape, sheet_name: str) -> None:
    frame = title_shape.text_frame
    frame.clear()
    _apply_text_frame_style(
        frame,
        font_name=TITLE_FONT_NAME,
        font_size=TITLE_FONT_SIZE,
        bold=True,
    )
    paragraph = frame.paragraphs[0]
    run = paragraph.add_run()
    run.text = sheet_name
    _set_run_font(run, name=TITLE_FONT_NAME, size=TITLE_FONT_SIZE, bold=True)
    _normalize_text_frame_xml(
        frame,
        font_name=TITLE_FONT_NAME,
        font_sz=TITLE_FONT_SZ_XML,
    )


def _normalize_table_fonts(table) -> None:
    """Принудительно выравнивает шрифт во всех ячейках (в т.ч. наследие шаблона)."""
    for row in table.rows:
        for cell in row.cells:
            frame = cell.text_frame
            frame.auto_size = MSO_AUTO_SIZE.NONE
            frame.word_wrap = True
            for paragraph in frame.paragraphs:
                paragraph.level = 0
                paragraph.space_after = Pt(0)
                paragraph.space_before = Pt(0)
                _set_paragraph_font(
                    paragraph,
                    name=TABLE_FONT_NAME,
                    size=TABLE_FONT_SIZE,
                    bold=False,
                )
                for run in paragraph.runs:
                    _set_run_font(
                        run,
                        name=TABLE_FONT_NAME,
                        size=TABLE_FONT_SIZE,
                        bold=False,
                    )
            _normalize_cell_xml(cell, font_name=TABLE_FONT_NAME, font_sz=TABLE_FONT_SZ_XML)


def _find_column(columns: list[str], pattern: str) -> str:
    regex = re.compile(pattern, re.IGNORECASE)
    for column in columns:
        if regex.search(column.strip()):
            return column
    return ""


def _mapped_columns(columns: list[str]) -> list[str]:
    return [
        _find_column(columns, r"^Дата"),
        _find_column(columns, r"^Проект"),
        _find_column(columns, r"Описание"),
        _find_column(columns, r"Зачем"),
    ]


def _row_values(row: dict[str, str], columns: list[str], col_count: int) -> list[str]:
    mapped = _mapped_columns(columns)
    values: list[str] = []
    for index in range(col_count):
        column_name = mapped[index] if index < len(mapped) else ""
        values.append((row.get(column_name, "") if column_name else "").strip())
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

    table_shape, table = _find_table(slide)
    if table is None:
        return

    target_table_height = int(table_shape.height) if table_shape is not None else None

    col_count = len(table.columns)
    data_rows = len(rows)
    for row_index in range(len(table.rows)):
        if row_index < data_rows:
            values = _row_values(rows[row_index], columns, col_count)
        else:
            values = [""] * col_count
        table_row = table.rows[row_index]
        for col_index in range(col_count):
            value = values[col_index] if col_index < len(values) else ""
            _replace_cell_text(table_row.cells[col_index], value)

    _normalize_table_fonts(table)
    _resize_table_rows(table, data_rows, target_height=target_table_height)


def _build_slide_specs(
    data: ProductStatusB2BOut,
    catalog: TemplateCatalog,
) -> list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]]:
    specs: list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]] = []
    for sheet in data.sheets:
        for template, chunk in catalog.chunk_plan(sheet.name, sheet.rows, sheet.columns):
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

    while len(output_prs.slides) > 1:
        _delete_slide(output_prs, len(output_prs.slides) - 1)

    for sheet, template, chunk in specs:
        source_slide = source_prs.slides[template.index]
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
