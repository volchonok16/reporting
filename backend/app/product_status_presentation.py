from __future__ import annotations

import io
import logging
import re
import uuid
from copy import deepcopy
from xml.sax.saxutils import escape as xml_escape
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
from app.product_status_rich_text import display_cell_text, split_highlight_segments
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
TABLE_FONT_SIZE_DENSE = Pt(8)
TABLE_FONT_SZ_XML = "1000"
TABLE_FONT_SZ_DENSE_XML = "800"
TABLE_CELL_MARGIN = Pt(3)
TABLE_LINE_SPACING = 1.05
TABLE_DENSE_LINE_SPACING = 1.0
WHY_COLUMN_INDEX = 3
COVER_DATE_FONT_SIZE = Pt(14)
COVER_DATE_COLOR = RGBColor(0x55, 0x55, 0x55)
_CELL_FONT_BY_INDEX: tuple[tuple[Pt, str], ...] = (
    (TABLE_FONT_SIZE, TABLE_FONT_SZ_XML),
    (TABLE_FONT_SIZE, TABLE_FONT_SZ_XML),
    (TABLE_FONT_SIZE, TABLE_FONT_SZ_XML),
    (TABLE_FONT_SIZE_DENSE, TABLE_FONT_SZ_DENSE_XML),
)
COVER_SLIDE_INDEX = 0
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main"
SECTION_EXT_URI = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"
COVER_SECTION_NAME = "Раздел по умолчанию"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
LINE_HEIGHT_EMU = 145000
MIN_ROW_HEIGHT_EMU = 396000
ROW_PADDING_EMU = 50000
CHAR_WIDTH_EMU = 76000
HEIGHT_SAFETY_RATIO = 1.0
LONG_CELL_CHARS = 180
HIGHLIGHT_COLOR_XML = "FFFF00"


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
            if index == COVER_SLIDE_INDEX:
                continue
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

        return cls(title_slide_index=COVER_SLIDE_INDEX, templates=templates)

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

    def _primary_templates(self, pool: list[ContentSlideTemplate]) -> list[ContentSlideTemplate]:
        """Полноразмерные макеты слайда — без урезанных вариантов из шаблона."""
        if not pool:
            return pool
        max_height = max(item.table_height for item in pool)
        height_floor = int(max_height * 0.85)
        primary = [
            item
            for item in pool
            if item.table_height >= height_floor
            and item.table_height // max(item.row_count, 1) >= MIN_ROW_HEIGHT_EMU // 2
        ]
        return primary or list(pool)

    def _canonical_table_height(self, pool: list[ContentSlideTemplate]) -> int:
        return max(item.table_height for item in self._primary_templates(pool))

    def _max_rows_for_pool(self, pool: list[ContentSlideTemplate]) -> int:
        return max(item.row_count for item in self._primary_templates(pool))

    def chunk_plan(
        self,
        sheet_name: str,
        rows: list[dict[str, str]],
        columns: list[str],
    ) -> list[tuple[ContentSlideTemplate, list[dict[str, str]]]]:
        pool = self.template_pool(sheet_name)
        if not rows:
            return [(self._pick_template_for_chunk(pool, 1), [])]

        primary = self._primary_templates(pool)
        max_table_height = int(self._canonical_table_height(pool) * HEIGHT_SAFETY_RATIO)
        max_pool_rows = self._max_rows_for_pool(pool)
        layout_template = max(primary, key=lambda item: item.table_height)
        col_chars = layout_template.col_chars_per_line

        chunks: list[tuple[ContentSlideTemplate, list[dict[str, str]]]] = []
        current_chunk: list[dict[str, str]] = []
        current_height = 0

        for row in rows:
            values = _row_values(row, columns, 4)
            row_height = _estimate_row_height(values, col_chars)

            should_split = bool(current_chunk) and (
                current_height + row_height > max_table_height
                or len(current_chunk) >= max_pool_rows
            )

            if should_split:
                chunks.append((self._pick_template_for_chunk(pool, len(current_chunk)), current_chunk))
                current_chunk = []
                current_height = 0

            current_chunk.append(row)
            current_height += row_height

        if current_chunk:
            chunks.append((self._pick_template_for_chunk(pool, len(current_chunk)), current_chunk))

        return self._consolidate_chunks(pool, chunks, columns)

    def _chunk_height(
        self,
        template: ContentSlideTemplate,
        chunk: list[dict[str, str]],
        columns: list[str],
    ) -> int:
        col_count = len(template.col_chars_per_line)
        return sum(
            _estimate_row_height(_row_values(row, columns, col_count), template.col_chars_per_line)
            for row in chunk
        )

    def _consolidate_chunks(
        self,
        pool: list[ContentSlideTemplate],
        chunks: list[tuple[ContentSlideTemplate, list[dict[str, str]]]],
        columns: list[str],
    ) -> list[tuple[ContentSlideTemplate, list[dict[str, str]]]]:
        """Склеивает хвостовые мелкие куски, чтобы не плодить полупустые слайды."""
        if not chunks:
            return chunks

        max_height = int(self._canonical_table_height(pool) * HEIGHT_SAFETY_RATIO)
        merged: list[tuple[ContentSlideTemplate, list[dict[str, str]]]] = [chunks[0]]
        for template, chunk in chunks[1:]:
            prev_template, prev_chunk = merged[-1]
            combined = prev_chunk + chunk
            combined_template = self._pick_template_for_chunk(pool, len(combined))
            combined_height = self._chunk_height(combined_template, combined, columns)
            if (
                len(combined) <= combined_template.row_count
                and combined_height <= max_height
            ):
                merged[-1] = (combined_template, combined)
                continue
            merged.append((template, chunk))
        return merged

    def _pick_template_for_chunk(
        self,
        pool: list[ContentSlideTemplate],
        row_count: int,
    ) -> ContentSlideTemplate:
        primary = self._primary_templates(pool)
        fitting = [item for item in primary if item.row_count >= row_count]
        if fitting:
            return min(fitting, key=lambda item: (item.row_count, item.index))
        return max(primary, key=lambda item: item.row_count)

    def _pick_default_template(self) -> ContentSlideTemplate:
        if not self._templates:
            raise HTTPException(
                status_code=503,
                detail="В шаблоне не найдено контентных слайдов.",
            )
        return max(
            self._primary_templates(self._templates),
            key=lambda item: (item.row_count, item.table_height, -item.index),
        )


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


_SHAPE_LOCK_TAGS = (
    qn("a:spLocks"),
    qn("a:graphicFrameLocks"),
    qn("a:picLocks"),
)


def _strip_shape_locks(element) -> None:
    """Снимает XML-блокировки фигур — иначе PowerPoint не даёт править текст в таблице."""
    for tag in _SHAPE_LOCK_TAGS:
        for node in list(element.iter(tag)):
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)


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
        _strip_shape_locks(new_element)
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
    return any(len(display_cell_text(value)) > LONG_CELL_CHARS for value in values[2:4])


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
    use_rgb_color: bool = True,
) -> None:
    run.font.name = name
    run.font.size = size
    run.font.bold = bold
    if use_rgb_color:
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


def _cell_font_size(col_index: int, text: str = "") -> tuple[Pt, str]:
    del text
    if 0 <= col_index < len(_CELL_FONT_BY_INDEX):
        return _CELL_FONT_BY_INDEX[col_index]
    return TABLE_FONT_SIZE, TABLE_FONT_SZ_XML


def _cell_line_spacing(col_index: int) -> float:
    if col_index == WHY_COLUMN_INDEX:
        return TABLE_DENSE_LINE_SPACING
    return TABLE_LINE_SPACING


def _apply_table_cell_frame_style(
    frame,
    *,
    font_name: str,
    font_size: Pt,
    col_index: int,
) -> None:
    frame.word_wrap = True
    frame.vertical_anchor = MSO_VERTICAL_ANCHOR.TOP
    frame.margin_left = TABLE_CELL_MARGIN
    frame.margin_right = TABLE_CELL_MARGIN
    frame.margin_top = TABLE_CELL_MARGIN
    frame.margin_bottom = TABLE_CELL_MARGIN

    line_spacing = _cell_line_spacing(col_index)
    for paragraph in frame.paragraphs:
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.space_after = Pt(0)
        paragraph.space_before = Pt(0)
        paragraph.level = 0
        paragraph.line_spacing = line_spacing
        for run in paragraph.runs:
            _set_run_font(
                run,
                name=font_name,
                size=font_size,
                bold=False,
                use_rgb_color=False,
            )


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


def _set_xml_theme_text(rpr_element) -> None:
    for child in list(rpr_element):
        if child.tag == qn("a:solidFill"):
            rpr_element.remove(child)
    rpr_element.insert(
        0,
        parse_xml(f'<a:solidFill xmlns:a="{A_NS}"><a:schemeClr val="tx1"/></a:solidFill>'),
    )


def _reset_paragraph_default_run_props(tx_body) -> None:
    if tx_body is None:
        return
    for paragraph_props in tx_body.findall(".//" + qn("a:pPr")):
        for default_props in list(paragraph_props.findall(qn("a:defRPr"))):
            paragraph_props.remove(default_props)
        paragraph_props.append(parse_xml(f'<a:defRPr xmlns:a="{A_NS}"/>'))


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


def _set_xml_latin_typeface(rpr_element, font_name: str) -> None:
    latin = rpr_element.find(qn("a:latin"))
    if latin is None:
        latin = parse_xml(f'<a:latin xmlns:a="{A_NS}" typeface="{font_name}"/>')
        rpr_element.append(latin)
    else:
        latin.set("typeface", font_name)


def _reset_cell_tc_pr(tc) -> None:
    tc_pr = tc.find(qn("a:tcPr"))
    if tc_pr is None:
        tc_pr = parse_xml(f'<a:tcPr xmlns:a="{A_NS}"/>')
        tc.insert(0, tc_pr)

    for tag in (
        "a:solidFill",
        "a:noFill",
        "a:gradFill",
        "a:blipFill",
        "a:pattFill",
        "a:grpFill",
        "a:lnL",
        "a:lnR",
        "a:lnT",
        "a:lnB",
        "a:lnTlToBr",
        "a:lnBlToTr",
    ):
        for node in list(tc_pr.findall(qn(tag))):
            tc_pr.remove(node)

    tc_pr.insert(0, parse_xml(f'<a:noFill xmlns:a="{A_NS}"/>'))
    tc_pr.set("anchor", "t")
    for attr in ("marL", "marR", "marT", "marB", "vert", "horzAnchor"):
        tc_pr.attrib.pop(attr, None)


def _reset_cell_tx_body(tc) -> None:
    old = tc.find(qn("a:txBody"))
    if old is not None:
        tc.remove(old)
    tc.append(
        parse_xml(
            f'<a:txBody xmlns:a="{A_NS}">'
            f'<a:bodyPr wrap="square" anchor="t" lIns="38100" rIns="38100" '
            f'tIns="38100" bIns="38100"/>'
            f"<a:lstStyle/>"
            f'<a:p><a:pPr algn="l" lvl="0"><a:buNone/><a:defRPr/></a:pPr>'
            f'<a:endParaRPr lang="ru-RU"/></a:p>'
            f"</a:txBody>"
        )
    )


def _reset_table_cell(cell) -> None:
    tc = cell._tc
    _reset_cell_tc_pr(tc)
    _reset_cell_tx_body(tc)


def _reset_table(table) -> None:
    for row in table.rows:
        for cell in row.cells:
            _reset_table_cell(cell)


def _reset_text_frame(frame) -> None:
    frame.clear()
    frame.word_wrap = True
    frame.auto_size = MSO_AUTO_SIZE.NONE
    frame.vertical_anchor = MSO_VERTICAL_ANCHOR.TOP
    frame.margin_left = TABLE_CELL_MARGIN
    frame.margin_right = TABLE_CELL_MARGIN
    frame.margin_top = TABLE_CELL_MARGIN
    frame.margin_bottom = TABLE_CELL_MARGIN


def _normalize_tx_body_element(
    tx_body,
    *,
    font_name: str,
    font_sz: str,
    align: str = "l",
) -> None:
    if tx_body is None:
        return

    body_pr = tx_body.find(qn("a:bodyPr"))
    if body_pr is not None:
        body_pr.set("wrap", "square")
        body_pr.set("anchor", "t")

    for paragraph_props in tx_body.findall(".//" + qn("a:pPr")):
        for bullet_tag in ("buChar", "buAutoNum", "buBlip", "buFont"):
            for bullet_node in paragraph_props.findall(qn(f"a:{bullet_tag}")):
                paragraph_props.remove(bullet_node)
        if paragraph_props.find(qn("a:buNone")) is None:
            paragraph_props.insert(0, parse_xml(f'<a:buNone xmlns:a="{A_NS}"/>'))
        paragraph_props.set("lvl", "0")
        paragraph_props.set("algn", align)
        for spacing_tag in ("spcBef", "spcAft", "lnSpc"):
            for spacing_node in paragraph_props.findall(qn(f"a:{spacing_tag}")):
                paragraph_props.remove(spacing_node)

    for prop_tag in ("a:rPr", "a:endParaRPr"):
        for props in tx_body.findall(".//" + qn(prop_tag)):
            props.set("sz", font_sz)
            props.set("dirty", "0")
            props.attrib.pop("b", None)
            props.attrib.pop("i", None)
            _set_xml_latin_typeface(props, font_name)
            _set_xml_theme_text(props)

    _reset_paragraph_default_run_props(tx_body)


def _normalize_table_cells_xml(table) -> None:
    for row in table.rows:
        for col_index, cell in enumerate(row.cells):
            _, font_sz_xml = _cell_font_size(col_index, cell.text_frame.text)
            tx_body = cell._tc.txBody
            if tx_body is not None:
                _normalize_tx_body_element(
                    tx_body,
                    font_name=TABLE_FONT_NAME,
                    font_sz=font_sz_xml,
                )


def _ensure_table_cells_editable(table) -> None:
    """Оставляет в ячейках простой txBody, совместимый с редактированием в PowerPoint."""
    for row in table.rows:
        for cell in row.cells:
            tc = cell._tc
            tc_pr = tc.find(qn("a:tcPr"))
            if tc_pr is None:
                tc_pr = parse_xml(f'<a:tcPr xmlns:a="{A_NS}" anchor="t"/>')
                tc.append(tc_pr)
            else:
                tc_pr.set("anchor", "t")

            tx_body = tc.txBody
            if tx_body is None:
                continue
            body_pr = tx_body.find(qn("a:bodyPr"))
            if body_pr is not None:
                body_pr.set("wrap", "square")
                body_pr.set("anchor", "t")


def _normalize_text_frame_xml(frame, *, font_name: str, font_sz: str) -> None:
    _normalize_tx_body_element(frame._txBody, font_name=font_name, font_sz=font_sz)


def _delete_table_row(table, row_index: int) -> None:
    tbl = table._tbl
    tbl.remove(tbl.tr_lst[row_index])


def _trim_table_rows(table, data_rows: int) -> None:
    while len(table.rows) > data_rows:
        _delete_table_row(table, len(table.rows) - 1)


def _scale_row_heights(min_heights: list[int], target_height: int) -> list[int]:
    total = sum(min_heights)
    if total <= 0 or total == target_height:
        return min_heights

    scaled = [int(height * target_height / total) for height in min_heights]
    delta = target_height - sum(scaled)
    if delta == 0:
        return scaled

    order = sorted(range(len(scaled)), key=lambda index: min_heights[index], reverse=True)
    for offset in range(delta):
        scaled[order[offset % len(order)]] += 1
    return scaled


def _layout_table_rows(
    table,
    *,
    rows: list[dict[str, str]],
    columns: list[str],
    target_height: int | None,
) -> None:
    data_rows = len(rows)
    if data_rows <= 0:
        return

    col_count = len(table.columns)
    col_chars = _column_chars_per_line(table)
    min_heights = [
        max(
            MIN_ROW_HEIGHT_EMU,
            _estimate_row_height(_row_values(row, columns, col_count), col_chars),
        )
        for row in rows
    ]

    if not any(min_heights):
        for row in table.rows:
            row.height = MIN_ROW_HEIGHT_EMU
        return

    row_heights = (
        _scale_row_heights(min_heights, target_height)
        if target_height is not None
        else min_heights
    )
    for index, row in enumerate(table.rows):
        row.height = row_heights[index]


def _resize_table_shape(table_shape, table, *, max_height: int | None = None) -> None:
    total_height = sum(int(row.height) for row in table.rows)
    if total_height <= 0:
        return
    if max_height is not None:
        table_shape.height = max_height
        return
    table_shape.height = total_height


def _fill_cell_highlighted_text(
    frame,
    value: str,
    *,
    col_index: int,
    font_size: Pt,
) -> None:
    lines = value.split("\n") if value else []
    for line_index, line in enumerate(lines or [""]):
        paragraph = frame.paragraphs[0] if line_index == 0 else frame.add_paragraph()
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.space_after = Pt(0)
        paragraph.space_before = Pt(0)
        paragraph.level = 0
        paragraph.line_spacing = _cell_line_spacing(col_index)
        for segment_text, highlighted in split_highlight_segments(line):
            if not segment_text:
                continue
            run = paragraph.add_run()
            run.text = segment_text
            _set_run_font(
                run,
                name=TABLE_FONT_NAME,
                size=font_size,
                bold=False,
                use_rgb_color=False,
            )
            if highlighted:
                _set_run_highlight(run)


def _replace_cell_text(cell, text: str, *, col_index: int) -> None:
    value = _sanitize_cell_text(text)
    display = display_cell_text(value)
    font_size, font_sz_xml = _cell_font_size(col_index, value)
    _reset_table_cell(cell)
    frame = cell.text_frame

    if "$" in value:
        _fill_cell_highlighted_text(
            frame,
            value,
            col_index=col_index,
            font_size=font_size,
        )
    else:
        cell.text = display

    _apply_table_cell_frame_style(
        frame,
        font_name=TABLE_FONT_NAME,
        font_size=font_size,
        col_index=col_index,
    )
    for paragraph in frame.paragraphs:
        paragraph.alignment = PP_ALIGN.LEFT
        paragraph.space_after = Pt(0)
        paragraph.space_before = Pt(0)
        paragraph.level = 0
        paragraph.line_spacing = _cell_line_spacing(col_index)
        for run in paragraph.runs:
            _set_run_font(
                run,
                name=TABLE_FONT_NAME,
                size=font_size,
                bold=False,
                use_rgb_color=False,
            )
    _normalize_tx_body_element(
        frame._txBody,
        font_name=TABLE_FONT_NAME,
        font_sz=font_sz_xml,
    )


def _replace_title(title_shape, sheet_name: str) -> None:
    frame = title_shape.text_frame
    _reset_text_frame(frame)
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
    """Принудительно выравнивает шрифт во всех ячейках после сброса стилей шаблона."""
    for row in table.rows:
        for col_index, cell in enumerate(row.cells):
            text = cell.text_frame.text
            font_size, _ = _cell_font_size(col_index, text)
            frame = cell.text_frame
            _apply_table_cell_frame_style(
                frame,
                font_name=TABLE_FONT_NAME,
                font_size=font_size,
                col_index=col_index,
            )
            for paragraph in frame.paragraphs:
                for run in paragraph.runs:
                    _set_run_font(
                        run,
                        name=TABLE_FONT_NAME,
                        size=font_size,
                        bold=False,
                        use_rgb_color=False,
                    )
    _normalize_table_cells_xml(table)


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
    """Сопоставление колонок Google Sheets → 4 колонки таблицы PPTX."""
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


def _fill_cover_slide(slide, *, title: str, generated_at: datetime) -> None:
    title_shape = _find_title_shape(slide)
    if title_shape is None:
        return

    frame = title_shape.text_frame
    _reset_text_frame(frame)
    _apply_text_frame_style(
        frame,
        font_name=TITLE_FONT_NAME,
        font_size=TITLE_FONT_SIZE,
        bold=True,
    )

    title_paragraph = frame.paragraphs[0]
    title_run = title_paragraph.add_run()
    title_run.text = title
    _set_run_font(title_run, name=TITLE_FONT_NAME, size=TITLE_FONT_SIZE, bold=True)

    date_paragraph = frame.add_paragraph()
    date_paragraph.alignment = PP_ALIGN.LEFT
    date_paragraph.space_before = Pt(8)
    date_run = date_paragraph.add_run()
    date_run.text = generated_at.strftime("%d.%m.%Y")
    _set_run_font(
        date_run,
        name=TABLE_FONT_NAME,
        size=COVER_DATE_FONT_SIZE,
        bold=False,
    )
    date_run.font.color.rgb = COVER_DATE_COLOR

    _normalize_text_frame_xml(
        frame,
        font_name=TITLE_FONT_NAME,
        font_sz=TITLE_FONT_SZ_XML,
    )


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

    _reset_table(table)

    for table_row in table.rows:
        for col_index in range(col_count):
            _replace_cell_text(table_row.cells[col_index], "", col_index=col_index)

    for row_index in range(min(len(table.rows), data_rows)):
        values = _row_values(rows[row_index], columns, col_count)
        table_row = table.rows[row_index]
        for col_index in range(col_count):
            value = values[col_index] if col_index < len(values) else ""
            _replace_cell_text(table_row.cells[col_index], value, col_index=col_index)

    _trim_table_rows(table, data_rows)
    _normalize_table_fonts(table)
    _ensure_table_cells_editable(table)
    _layout_table_rows(
        table,
        rows=rows,
        columns=columns,
        target_height=target_table_height,
    )
    if table_shape is not None:
        _strip_shape_locks(table_shape.element)
        _resize_table_shape(table_shape, table, max_height=target_table_height)


def _section_name_for_sheet(sheet_name: str) -> str:
    """Имя секции PowerPoint (блок в навигации) по листу Google Sheets."""
    short = sheet_name.split(":", 1)[1].strip() if ":" in sheet_name else sheet_name.strip()
    aliases = {
        "voice": "Voice",
        "продуктовый маркетинг": "Продуктовый Маркетинг",
    }
    return aliases.get(short.casefold(), short)


def _remove_section_list(prs: Presentation) -> None:
    root = prs.element
    ext_lst = root.find(f"{{{P_NS}}}extLst")
    if ext_lst is None:
        return
    for ext in list(ext_lst.findall(f"{{{P_NS}}}ext")):
        if ext.find(f"{{{P14_NS}}}sectionLst") is not None:
            ext_lst.remove(ext)


def _apply_presentation_sections(prs: Presentation, slide_sections: list[str]) -> None:
    """Пересобирает p14:sectionLst — группы слайдов по листам источника."""
    if len(slide_sections) != len(prs.slides):
        raise ValueError("Количество секций не совпадает с количеством слайдов")

    _remove_section_list(prs)
    root = prs.element
    ext_lst = root.find(f"{{{P_NS}}}extLst")
    if ext_lst is None:
        ext_lst = parse_xml(f'<p:extLst xmlns:p="{P_NS}"/>')
        root.append(ext_lst)

    groups: list[tuple[str, list]] = []
    for slide, section_name in zip(prs.slides, slide_sections, strict=True):
        if groups and groups[-1][0] == section_name:
            groups[-1][1].append(slide)
        else:
            groups.append((section_name, [slide]))

    parts = [
        f'<p:ext uri="{SECTION_EXT_URI}" xmlns:p="{P_NS}" xmlns:p14="{P14_NS}">',
        "<p14:sectionLst>",
    ]
    for section_name, slides in groups:
        section_id = f"{{{uuid.uuid4()}}}"
        safe_name = xml_escape(section_name, {'"': "&quot;"})
        parts.append(f'<p14:section name="{safe_name}" id="{section_id}">')
        parts.append("<p14:sldIdLst>")
        for slide in slides:
            parts.append(f'<p14:sldId id="{slide.slide_id}"/>')
        parts.append("</p14:sldIdLst></p14:section>")
    parts.append("</p14:sectionLst></p:ext>")

    ext_lst.append(parse_xml("".join(parts)))


def _read_presentation_sections(prs: Presentation) -> list[tuple[str, list[int]]]:
    root = prs.element
    ext_lst = root.find(f"{{{P_NS}}}extLst")
    if ext_lst is None:
        return []
    result: list[tuple[str, list[int]]] = []
    for ext in ext_lst.findall(f"{{{P_NS}}}ext"):
        sec_list = ext.find(f"{{{P14_NS}}}sectionLst")
        if sec_list is None:
            continue
        for sec in sec_list.findall(f"{{{P14_NS}}}section"):
            name = sec.get("name") or ""
            slide_ids = [
                int(node.get("id"))
                for node in sec.findall(f"{{{P14_NS}}}sldIdLst/{{{P14_NS}}}sldId")
                if node.get("id")
            ]
            result.append((name, slide_ids))
    return result


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

    cover_slide = output_prs.slides[catalog.title_slide_index]
    _fill_cover_slide(cover_slide, title=data.title, generated_at=generated_at)

    while len(output_prs.slides) > 1:
        _delete_slide(output_prs, len(output_prs.slides) - 1)

    slide_sections = [COVER_SECTION_NAME]
    for sheet, template, chunk in specs:
        source_slide = source_prs.slides[template.index]
        new_slide = _duplicate_slide_safe(output_prs, source_slide)
        _fill_content_slide(
            new_slide,
            sheet_name=sheet.name,
            columns=sheet.columns,
            rows=chunk,
        )
        slide_sections.append(_section_name_for_sheet(sheet.name))

    _apply_presentation_sections(output_prs, slide_sections)

    buffer = io.BytesIO()
    output_prs.save(buffer)
    filename = f"status-produkta-b2b-{generated_at.strftime('%Y%m%d')}.pptx"
    return buffer.getvalue(), filename
