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
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN, MSO_VERTICAL_ANCHOR
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
from pptx.util import Pt

from app.config import settings
from app.product_status_rich_text import display_cell_text, split_highlight_segments
from app.product_status_service import load_b2b_product_status
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

MOSCOW_TZ = ZoneInfo("Europe/Moscow")
DATE_PLACEHOLDER = "<%date>"
FIXED_SLIDE_COUNT = 3
COLUMN_COUNT = 4
WHY_COLUMN_INDEX = 3

TABLE_FONT_NAME = "T2 Rooftop"
TABLE_FONT_SIZE = Pt(10)
TABLE_FONT_SIZE_DENSE = Pt(8)
TITLE_FONT_SIZE = Pt(28)
TITLE_COLOR = RGBColor(0xFF, 0xFF, 0xFF)
TEXT_COLOR = RGBColor(0x00, 0x00, 0x00)
WHITE_FILL = RGBColor(0xFF, 0xFF, 0xFF)
HIGHLIGHT_COLOR_XML = "FFFF00"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

CHAR_WIDTH_EMU = 76000
LINE_HEIGHT_EMU = 145000
HEADER_ROW_HEIGHT_EMU = 320000
MIN_ROW_HEIGHT_EMU = 340000
ROW_PADDING_EMU = 45000
BODY_HEIGHT_EMU = 3_408_600
BODY_WIDTH_EMU = 8_900_700
COLUMN_WIDTH_RATIOS = (0.10, 0.14, 0.46, 0.30)

_CNVPR_TAGS = (
    "{http://schemas.openxmlformats.org/presentationml/2006/main}cNvPr",
    "{http://schemas.openxmlformats.org/drawingml/2006/main}cNvPr",
)

# 0-based индексы слайдов-образцов в Status.pptx (слайд 4 = индекс 3).
_SHEET_TEMPLATE_INDEX: dict[str, int] = {
    "продуктовый офис: core": 3,
    "продуктовый офис: m2m / iot": 4,
    "продуктовый офис: sms": 5,
    "продуктовый офис: voice": 6,
    "продуктовый офис: перспективные продукты": 7,
    "продуктовый офис: продуктовый маркетинг": 3,
}

# Совместимость со старыми тестами/импортами.
COVER_SECTION_NAME = "Раздел по умолчанию"
TABLE_FONT_SZ_XML = "1000"
TABLE_FONT_SZ_DENSE_XML = "800"
_CELL_FONT_BY_INDEX: tuple[tuple[Pt, str], ...] = (
    (TABLE_FONT_SIZE, TABLE_FONT_SZ_XML),
    (TABLE_FONT_SIZE, TABLE_FONT_SZ_XML),
    (TABLE_FONT_SIZE, TABLE_FONT_SZ_XML),
    (TABLE_FONT_SIZE_DENSE, TABLE_FONT_SZ_DENSE_XML),
)


@dataclass(frozen=True)
class ContentSlideTemplate:
    index: int
    title: str = ""
    row_count: int = 0
    column_count: int = COLUMN_COUNT
    table_height: int = BODY_HEIGHT_EMU
    col_chars_per_line: tuple[int, ...] = (12, 16, 54, 34)


class TemplateCatalog:
    """Минимальная обёртка для совместимости тестов — шаблон Status.pptx."""

    def __init__(self, *, title_slide_index: int, templates: list[ContentSlideTemplate]) -> None:
        self.title_slide_index = title_slide_index
        self._templates = templates
        self._by_title: dict[str, list[ContentSlideTemplate]] = {}
        for template in templates:
            key = _normalize_title(template.title)
            self._by_title.setdefault(key, []).append(template)
        self._default = templates[0] if templates else ContentSlideTemplate(index=3)

    @classmethod
    def from_presentation(cls, prs: Presentation) -> TemplateCatalog:
        templates = [
            ContentSlideTemplate(index=index, title=_slide_title(prs.slides[index]) or "")
            for index in sorted(set(_SHEET_TEMPLATE_INDEX.values()))
            if index < len(prs.slides)
        ]
        return cls(title_slide_index=0, templates=templates)

    def match(self, sheet_name: str) -> list[ContentSlideTemplate]:
        key = _normalize_title(sheet_name)
        index = _SHEET_TEMPLATE_INDEX.get(key, 3)
        return [ContentSlideTemplate(index=index, title=sheet_name)]

    def template_pool(self, sheet_name: str) -> list[ContentSlideTemplate]:
        return self.match(sheet_name)

    def chunk_plan(
        self,
        sheet_name: str,
        rows: list[dict[str, str]],
        columns: list[str],
    ) -> list[tuple[ContentSlideTemplate, list[dict[str, str]]]]:
        template = self.match(sheet_name)[0]
        chunks = _chunk_rows(rows, columns)
        if not chunks:
            return [(template, [])]
        return [(template, chunk) for chunk in chunks]


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


def _template_index_for_sheet(sheet_name: str) -> int:
    return _SHEET_TEMPLATE_INDEX.get(_normalize_title(sheet_name), 3)


def _section_name_for_sheet(sheet_name: str) -> str:
    short = sheet_name.split(":", 1)[1].strip() if ":" in sheet_name else sheet_name.strip()
    aliases = {
        "voice": "Voice",
        "продуктовый маркетинг": "Продуктовый Маркетинг",
    }
    return aliases.get(short.casefold(), short)


def _find_column(
    columns: list[str],
    pattern: str,
    *,
    exclude: set[str] | None = None,
) -> str:
    regex = re.compile(pattern, re.IGNORECASE)
    excluded = exclude or set()
    for column in columns:
        if column in excluded:
            continue
        if regex.search(column.strip()):
            return column
    return ""


def _mapped_columns(columns: list[str]) -> list[str]:
    slot_patterns = [
        (r"^Дата", r"Дата"),
        (r"^Проект", r"Проект"),
        (r"Описание",),
        (r"Зачем",),
    ]
    usable = [column.strip() for column in columns if column.strip()]
    mapped: list[str] = []
    used: set[str] = set()

    for patterns in slot_patterns:
        found = ""
        for pattern in patterns:
            found = _find_column(columns, pattern, exclude=used)
            if found:
                break
        if found:
            mapped.append(found)
            used.add(found)
        else:
            mapped.append("")

    remaining = [column for column in usable if column not in used]
    for index, column_name in enumerate(mapped):
        if column_name or not remaining:
            continue
        mapped[index] = remaining.pop(0)
        used.add(mapped[index])

    return mapped


def _row_values(row: dict[str, str], columns: list[str], col_count: int) -> list[str]:
    mapped = _mapped_columns(columns)
    values: list[str] = []
    for index in range(col_count):
        column_name = mapped[index] if index < len(mapped) else ""
        values.append((row.get(column_name, "") if column_name else "").strip())
    return values


def _cell_font_size(col_index: int, text: str = "") -> tuple[Pt, str]:
    del text
    if 0 <= col_index < len(_CELL_FONT_BY_INDEX):
        return _CELL_FONT_BY_INDEX[col_index]
    return TABLE_FONT_SIZE, TABLE_FONT_SZ_XML


def _column_chars_per_line(widths: tuple[int, ...]) -> tuple[int, ...]:
    return tuple(max(8, int(width / CHAR_WIDTH_EMU)) for width in widths)


def _column_widths(total_width: int) -> tuple[int, ...]:
    widths = [int(total_width * ratio) for ratio in COLUMN_WIDTH_RATIOS]
    widths[-1] = total_width - sum(widths[:-1])
    return tuple(widths)


def _sanitize_cell_text(text: str) -> str:
    cleaned = (text or "").replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in cleaned.split("\n")]
    return "\n".join(lines).strip()


def _estimate_row_height(values: list[str], col_chars_per_line: tuple[int, ...]) -> int:
    max_lines = 1
    for index, text in enumerate(values):
        cleaned = display_cell_text(text)
        if not cleaned:
            continue
        chars_per_line = col_chars_per_line[index] if index < len(col_chars_per_line) else 40
        explicit_lines = cleaned.count("\n") + 1
        wrapped_lines = max(1, (len(cleaned) + chars_per_line - 1) // chars_per_line)
        max_lines = max(max_lines, explicit_lines, wrapped_lines)
    return max(MIN_ROW_HEIGHT_EMU, max_lines * LINE_HEIGHT_EMU + ROW_PADDING_EMU)


def _chunk_rows(rows: list[dict[str, str]], columns: list[str]) -> list[list[dict[str, str]]]:
    if not rows:
        return [[]]

    col_widths = _column_widths(BODY_WIDTH_EMU)
    col_chars = _column_chars_per_line(col_widths)
    max_body_height = BODY_HEIGHT_EMU - HEADER_ROW_HEIGHT_EMU

    chunks: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    current_height = 0

    for row in rows:
        row_height = _estimate_row_height(_row_values(row, columns, COLUMN_COUNT), col_chars)
        if current and current_height + row_height > max_body_height:
            chunks.append(current)
            current = []
            current_height = 0
        current.append(row)
        current_height += row_height

    if current:
        chunks.append(current)
    return chunks


def _delete_slide(prs: Presentation, index: int) -> None:
    slide_ids = prs.slides._sldIdLst
    slide_id = slide_ids[index]
    r_id = slide_id.rId
    prs.part.drop_rel(r_id)
    slide_ids.remove(slide_id)


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
    dest = prs.slides.add_slide(source_slide.slide_layout)
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
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        if shape.is_placeholder and shape.placeholder_format.type == PP_PLACEHOLDER.CENTER_TITLE:
            text = shape.text_frame.text.strip()
            return text.split("\n")[0].strip() if text else None
    return None


def _find_title_shape(slide):
    for shape in slide.shapes:
        if shape.is_placeholder and shape.placeholder_format.type == PP_PLACEHOLDER.CENTER_TITLE:
            return shape
    return None


def _find_main_body_shape(slide):
    bodies = [
        shape
        for shape in slide.shapes
        if shape.is_placeholder and shape.placeholder_format.type == PP_PLACEHOLDER.BODY
    ]
    if not bodies:
        return None
    return max(bodies, key=lambda shape: shape.width * shape.height)


def _replace_placeholder_text(shape, text: str, *, font_size: Pt, color: RGBColor, bold: bool = False) -> None:
    frame = shape.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.vertical_anchor = MSO_VERTICAL_ANCHOR.TOP
    paragraph = frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.LEFT
    run = paragraph.add_run()
    run.text = text
    run.font.name = TABLE_FONT_NAME
    run.font.size = font_size
    run.font.bold = bold
    run.font.color.rgb = color


def _fill_date_slide(slide, generated_at: datetime) -> None:
    formatted = generated_at.strftime("%d.%m.%Y")
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        text = shape.text_frame.text
        if DATE_PLACEHOLDER not in text:
            continue
        shape.text_frame.text = text.replace(DATE_PLACEHOLDER, formatted)


def _set_run_highlight(run) -> None:
    r_pr = run._r.get_or_add_rPr()
    for child in list(r_pr):
        if child.tag == qn("a:highlight"):
            r_pr.remove(child)
    r_pr.insert(
        0,
        parse_xml(
            f'<a:highlight xmlns:a="{A_NS}">'
            f'<a:srgbClr val="{HIGHLIGHT_COLOR_XML}"/></a:highlight>'
        ),
    )


def _fill_white_cell(cell, value: str, *, col_index: int) -> None:
    sanitized = _sanitize_cell_text(value)
    font_size, _ = _cell_font_size(col_index, sanitized)
    frame = cell.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.vertical_anchor = MSO_VERTICAL_ANCHOR.TOP
    frame.margin_left = Pt(3)
    frame.margin_right = Pt(3)
    frame.margin_top = Pt(3)
    frame.margin_bottom = Pt(3)

    cell.fill.solid()
    cell.fill.fore_color.rgb = WHITE_FILL

    lines = sanitized.split("\n") if sanitized else [""]
    for line_index, line in enumerate(lines):
        paragraph = frame.paragraphs[0] if line_index == 0 else frame.add_paragraph()
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.space_after = Pt(0)
        paragraph.space_before = Pt(0)
        for segment_text, highlighted in split_highlight_segments(line):
            if not segment_text:
                continue
            run = paragraph.add_run()
            run.text = segment_text
            run.font.name = TABLE_FONT_NAME
            run.font.size = font_size
            run.font.color.rgb = TEXT_COLOR
            if highlighted:
                _set_run_highlight(run)


def _apply_table_column_widths(table, total_width: int) -> None:
    widths = _column_widths(total_width)
    for index, width in enumerate(widths):
        table.columns[index].width = width


def _layout_table_rows(table, rows: list[dict[str, str]], columns: list[str], total_height: int) -> None:
    col_widths = _column_widths(BODY_WIDTH_EMU)
    col_chars = _column_chars_per_line(col_widths)
    data_heights = [
        _estimate_row_height(_row_values(row, columns, COLUMN_COUNT), col_chars) for row in rows
    ]
    header_height = HEADER_ROW_HEIGHT_EMU
    available = max(total_height - header_height, MIN_ROW_HEIGHT_EMU * max(len(rows), 1))
    if not data_heights:
        table.rows[0].height = header_height
        return

    total_min = sum(data_heights)
    if total_min <= available:
        table.rows[0].height = header_height
        for index, height in enumerate(data_heights, start=1):
            table.rows[index].height = height
        return

    scale = available / total_min
    table.rows[0].height = header_height
    scaled = [max(MIN_ROW_HEIGHT_EMU, int(height * scale)) for height in data_heights]
    delta = available - sum(scaled)
    if delta:
        scaled[-1] += delta
    for index, height in enumerate(scaled, start=1):
        table.rows[index].height = height


def _fill_content_slide(
    slide,
    *,
    sheet_name: str,
    columns: list[str],
    rows: list[dict[str, str]],
) -> None:
    title_shape = _find_title_shape(slide)
    if title_shape is not None:
        _replace_placeholder_text(
            title_shape,
            sheet_name,
            font_size=TITLE_FONT_SIZE,
            color=TITLE_COLOR,
            bold=True,
        )

    body_shape = _find_main_body_shape(slide)
    if body_shape is None:
        return

    mapped_headers = _mapped_columns(columns)
    data_rows = len(rows)
    table_shape = slide.shapes.add_table(
        data_rows + 1,
        COLUMN_COUNT,
        body_shape.left,
        body_shape.top,
        body_shape.width,
        body_shape.height,
    )
    table = table_shape.table
    _apply_table_column_widths(table, body_shape.width)

    for col_index, header in enumerate(mapped_headers):
        _fill_white_cell(table.rows[0].cells[col_index], header, col_index=col_index)

    for row_index, row in enumerate(rows, start=1):
        values = _row_values(row, columns, COLUMN_COUNT)
        for col_index, value in enumerate(values):
            _fill_white_cell(table.rows[row_index].cells[col_index], value, col_index=col_index)

    _layout_table_rows(table, rows, columns, body_shape.height)


def _build_slide_specs(
    data: ProductStatusB2BOut,
    catalog: TemplateCatalog,
) -> list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]]:
    specs: list[tuple[ProductStatusSheetOut, ContentSlideTemplate, list[dict[str, str]]]] = []
    for sheet in data.sheets:
        for template, chunk in catalog.chunk_plan(sheet.name, sheet.rows, sheet.columns):
            specs.append((sheet, template, chunk))
    return specs


def _read_presentation_sections(prs: Presentation) -> list[tuple[str, list[int]]]:
    return []


def generate_b2b_product_status_presentation() -> tuple[bytes, str]:
    data = load_b2b_product_status()

    template_path = _template_path()
    prs = Presentation(str(template_path))

    if len(prs.slides) < FIXED_SLIDE_COUNT + 1:
        raise HTTPException(
            status_code=503,
            detail="В шаблоне презентации должны быть титульный, служебные и контентные слайды.",
        )

    generated_at = datetime.now(MOSCOW_TZ)
    catalog = TemplateCatalog.from_presentation(prs)
    specs = _build_slide_specs(data, catalog)
    if not specs:
        raise HTTPException(
            status_code=502,
            detail="Нет данных для формирования презентации.",
        )

    _fill_date_slide(prs.slides[0], generated_at)

    for sheet, template, chunk in specs:
        template_index = _template_index_for_sheet(sheet.name)
        source_slide = prs.slides[template_index]
        new_slide = _duplicate_slide_safe(prs, source_slide)
        _fill_content_slide(
            new_slide,
            sheet_name=sheet.name,
            columns=sheet.columns,
            rows=chunk,
        )

    for index in sorted(set(_SHEET_TEMPLATE_INDEX.values()), reverse=True):
        if index >= FIXED_SLIDE_COUNT:
            _delete_slide(prs, index)

    buffer = io.BytesIO()
    prs.save(buffer)
    filename = f"status-produkta-b2b-{generated_at.strftime('%Y%m%d')}.pptx"
    return buffer.getvalue(), filename
