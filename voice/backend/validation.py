from __future__ import annotations

from dataclasses import dataclass
from itertools import islice
import math
from typing import Any

from .errors import AppError
from .importers import (
    FileImporter,
    FormattedMappingImporter,
    RowRecord,
    row_value,
)
from .mapping import (
    A_HEADER_TOKENS,
    B_HEADER_TOKENS,
    MappingParser,
    _header_token,
    is_raw_header,
)
from .models import HEADER, TemplateSettings
from .security import normalize_number


@dataclass(frozen=True, slots=True)
class SheetAnalysis:
    name: str
    rows: tuple[RowRecord, ...]
    raw_score: int
    formatted_score: int
    a_column: int | None
    b_column: int | None


class ValidationService:
    """Bounded inspection and input-column suggestion service."""

    def __init__(self, preview_limit: int = 100):
        self.preview_limit = preview_limit

    @staticmethod
    def _first_content_index(rows: tuple[RowRecord, ...]) -> int | None:
        return next(
            (
                index
                for index, row in enumerate(rows)
                if any(
                    value is not None and str(value).strip()
                    for value in row.values
                )
            ),
            None,
        )

    def _raw_columns(
        self, rows: tuple[RowRecord, ...]
    ) -> tuple[int | None, int | None, int]:
        if not rows:
            return None, None, 0
        width = min(max((len(row.values) for row in rows), default=0), 256)
        if width < 1:
            return None, None, 0
        header_index = self._first_content_index(rows)
        if header_index is None:
            return None, None, 0
        header = rows[header_index].values
        a_header = next(
            (
                index
                for index in range(width)
                if _header_token(row_value(header, index)) in A_HEADER_TOKENS
            ),
            None,
        )
        b_header = next(
            (
                index
                for index in range(width)
                if _header_token(row_value(header, index)) in B_HEADER_TOKENS
            ),
            None,
        )
        data_start = (
            header_index + 1
            if a_header is not None or b_header is not None
            else header_index
        )
        valid_counts = [0] * width
        for row in rows[data_start : data_start + 20]:
            for index in range(width):
                try:
                    if normalize_number(
                        row_value(row.values, index),
                        source_row=row.source_row,
                        field="A",
                        allow_whitespace_error=True,
                    ):
                        valid_counts[index] += 1
                except AppError:
                    continue
        ranked = sorted(range(width), key=lambda index: valid_counts[index], reverse=True)
        a_column = a_header
        b_column = b_header
        if a_column is None and ranked and valid_counts[ranked[0]] > 0:
            a_column = ranked[0]
        if b_column is None:
            b_column = next(
                (
                    index
                    for index in ranked
                    if index != a_column and valid_counts[index] > 0
                ),
                None,
            )
        score = 0
        if a_header is not None:
            score += 50
        if b_header is not None:
            score += 50
        if a_column is not None:
            score += valid_counts[a_column]
        if b_column is not None:
            score += valid_counts[b_column]
        if a_column is None or a_column == b_column:
            score = 0
        elif b_column is None and width > 1:
            score = 0
        return a_column, b_column, score

    def _formatted_score(
        self, rows: tuple[RowRecord, ...], template: TemplateSettings | None
    ) -> int:
        if not rows:
            return 0
        score = 0
        parser = (
            MappingParser(template)
            if template is not None
            else MappingParser(
                auto_detect=True,
                allow_mixed_templates=True,
            )
        )
        for row in rows[:21]:
            value = next(
                (
                    cell
                    for cell in row.values
                    if cell is not None and str(cell).strip()
                ),
                None,
            )
            if value is None:
                continue
            text = str(value)
            if text == HEADER:
                score += 100
                continue
            try:
                parser.parse(text, source_row=row.source_row)
                score += 10
            except AppError:
                continue
        return score

    def analyze(
        self,
        importer: FileImporter,
        template: TemplateSettings | None = None,
    ) -> list[SheetAnalysis]:
        analyses: list[SheetAnalysis] = []
        sheets = importer.listSheets()
        per_sheet_limit = min(
            self.preview_limit,
            max(1, 10_000 // max(1, len(sheets))),
        )
        for sheet in sheets:
            rows = tuple(
                RowRecord(row.source_row, row.values[:256])
                for row in importer.preview(sheet, per_sheet_limit)
            )
            a_column, b_column, raw_score = self._raw_columns(rows)
            formatted_score = self._formatted_score(rows, template)
            analyses.append(
                SheetAnalysis(
                    name=sheet,
                    rows=rows,
                    raw_score=raw_score,
                    formatted_score=formatted_score,
                    a_column=a_column,
                    b_column=b_column,
                )
            )
        return analyses

    def choose(
        self,
        importer: FileImporter,
        *,
        requested_sheet: str | None,
        requested_mode: str,
        template: TemplateSettings | None = None,
    ) -> tuple[SheetAnalysis, str]:
        analyses = self.analyze(importer, template)
        if not analyses:
            raise AppError("EMPTY_FILE", "Файл не содержит листов")
        if requested_sheet is not None:
            selected = next(
                (analysis for analysis in analyses if analysis.name == requested_sheet),
                None,
            )
            if selected is None:
                raise AppError("SHEET_NOT_FOUND", "Указанный лист не найден")
        elif requested_mode == "raw":
            selected = max(analyses, key=lambda analysis: analysis.raw_score)
        elif requested_mode == "formatted":
            selected = max(analyses, key=lambda analysis: analysis.formatted_score)
        else:
            selected = max(
                analyses,
                key=lambda analysis: max(
                    analysis.raw_score, analysis.formatted_score
                ),
            )
        if requested_mode == "auto":
            mode = (
                "formatted"
                if selected.formatted_score > selected.raw_score
                else "raw"
            )
        else:
            mode = requested_mode
        return selected, mode

    def inspect_response(
        self,
        importer: FileImporter,
        *,
        requested_sheet: str | None,
        requested_mode: str,
        preview_rows: int | None,
    ) -> dict[str, Any]:
        analyses = self.analyze(importer)
        if not analyses:
            raise AppError("EMPTY_FILE", "Файл не содержит листов")
        if requested_sheet is not None:
            selected = next(
                (analysis for analysis in analyses if analysis.name == requested_sheet),
                None,
            )
            if selected is None:
                raise AppError("SHEET_NOT_FOUND", "Указанный лист не найден")
        elif requested_mode == "raw":
            selected = max(analyses, key=lambda analysis: analysis.raw_score)
        elif requested_mode == "formatted":
            selected = max(analyses, key=lambda analysis: analysis.formatted_score)
        else:
            selected = max(
                analyses,
                key=lambda analysis: max(
                    analysis.raw_score, analysis.formatted_score
                ),
            )
        mode = requested_mode
        if mode == "auto":
            mode = (
                "formatted"
                if selected.formatted_score > selected.raw_score
                else "raw"
            )
        source_has_only_a = (
            mode == "raw"
            and selected.a_column is not None
            and selected.b_column is None
        )
        content_index = self._first_content_index(selected.rows)
        first_values = (
            selected.rows[content_index].values
            if content_index is not None
            else ()
        )
        has_raw_headers = (
            selected.a_column is not None
            and _header_token(row_value(first_values, selected.a_column))
            in A_HEADER_TOKENS
            and (
                source_has_only_a
                or (
                    selected.b_column is not None
                    and _header_token(
                        row_value(first_values, selected.b_column)
                    )
                    in B_HEADER_TOKENS
                )
            )
        )
        first_non_empty = next(
            (
                value
                for value in first_values
                if value is not None and str(value).strip()
            ),
            None,
        )
        has_formatted_header = (
            mode == "formatted" and str(first_non_empty or "") == HEADER
        )
        width = max((len(row.values) for row in selected.rows), default=0)
        columns = []
        for index in range(width):
            raw_name = row_value(first_values, index)
            name = (
                str(raw_name).strip()
                if (has_raw_headers or has_formatted_header)
                and raw_name not in (None, "")
                else f"Колонка {index + 1}"
            )
            columns.append({"index": index, "name": name})
        preview_start = content_index or 0
        if has_raw_headers or has_formatted_header:
            preview_start += 1
        source_rows = importer.iterateRows(selected.name)
        if preview_rows is not None:
            source_rows = islice(source_rows, preview_start + preview_rows)
        selected_rows = tuple(
            RowRecord(row.source_row, row.values[:256])
            for row in source_rows
        )

        def json_value(value: Any) -> Any:
            if isinstance(value, float) and not math.isfinite(value):
                return str(value)
            if value is None or isinstance(value, (str, int, float, bool)):
                return value
            return str(value)

        rows_for_preview = selected_rows[preview_start:]
        if preview_rows is not None:
            rows_for_preview = rows_for_preview[:preview_rows]
        preview = [
            {
                "sourceRow": row.source_row,
                "values": [json_value(value) for value in row.values],
            }
            for row in rows_for_preview
        ]
        read_rows = 0
        skipped_rows = 0
        invalid_values = 0
        empty_b = 0
        duplicate_a = 0
        duplicate_b = 0
        total_b = 0
        seen_a: set[str] = set()
        seen_pairs: set[tuple[str, str]] = set()
        seen_a_rows: dict[str, int] = {}
        seen_pair_rows: dict[tuple[str, str], int] = {}
        duplicate_findings: list[dict[str, Any]] = []
        whitespace_findings: list[dict[str, Any]] = []
        whitespace_numbers = 0
        parser = MappingParser(
            auto_detect=True,
            allow_mixed_templates=True,
            allow_number_whitespace=True,
        )
        for row in rows_for_preview:
            non_empty = [
                value
                for value in row.values
                if value is not None and str(value).strip()
            ]
            if not non_empty:
                skipped_rows += 1
                continue
            read_rows += 1
            try:
                if mode == "raw":
                    if selected.a_column is None:
                        invalid_values += 1
                        continue
                    raw_a = row_value(row.values, selected.a_column)
                    raw_b = (
                        row_value(row.values, selected.b_column)
                        if selected.b_column is not None
                        else None
                    )
                    a_number = normalize_number(
                        raw_a,
                        source_row=row.source_row,
                        field="A",
                        allow_whitespace_error=True,
                    )
                    if not a_number:
                        invalid_values += 1
                        continue
                    b_number = normalize_number(
                        raw_b,
                        source_row=row.source_row,
                        field="B",
                        allow_whitespace_error=True,
                    )
                    if not b_number:
                        b_number = a_number
                        empty_b += 1
                    b_numbers = (b_number,)
                else:
                    parsed = parser.parse(str(non_empty[0]), source_row=row.source_row)
                    a_number = parsed.a_number
                    b_numbers = parsed.b_numbers
                numbered_values = (("a", a_number),) + tuple(
                    ("b", value) for value in b_numbers
                )
                for kind, number in numbered_values:
                    if not any(char.isspace() for char in number):
                        continue
                    whitespace_numbers += 1
                    if len(whitespace_findings) < 200:
                        whitespace_findings.append(
                            {
                                "kind": kind,
                                "aNumber": a_number,
                                "bNumber": number if kind == "b" else None,
                                "sourceRow": row.source_row,
                            }
                        )
                if a_number in seen_a:
                    # In a raw A/B table, repeating the A-number is how several
                    # different B-numbers are attached to one mapping. It is a
                    # duplicate only in the formatted, one-mapping-per-row
                    # representation.
                    if mode == "formatted":
                        duplicate_a += 1
                        duplicate_findings.append(
                            {
                                "kind": "a",
                                "aNumber": a_number,
                                "bNumber": None,
                                "firstSourceRow": seen_a_rows[a_number],
                                "sourceRow": row.source_row,
                            }
                        )
                else:
                    seen_a.add(a_number)
                    seen_a_rows[a_number] = row.source_row
                for b_number in b_numbers:
                    total_b += 1
                    pair = (a_number, b_number)
                    if pair in seen_pairs:
                        duplicate_b += 1
                        duplicate_findings.append(
                            {
                                "kind": "b",
                                "aNumber": a_number,
                                "bNumber": b_number,
                                "firstSourceRow": seen_pair_rows[pair],
                                "sourceRow": row.source_row,
                            }
                        )
                    else:
                        seen_pairs.add(pair)
                        seen_pair_rows[pair] = row.source_row
            except AppError:
                invalid_values += 1
        preliminary = {
            "previewRows": len(preview),
            "readRows": read_rows,
            "uniqueA": len(seen_a),
            "totalB": total_b,
            "emptyB": empty_b,
            "duplicateA": duplicate_a,
            "duplicateB": duplicate_b,
            "invalidValues": invalid_values,
            "whitespaceNumbers": whitespace_numbers,
            "skippedRows": skipped_rows,
            "suggestedResultRows": len(seen_a),
        }
        return {
            "sheets": [
                {
                    "name": analysis.name,
                    "rawScore": analysis.raw_score,
                    "formattedScore": analysis.formatted_score,
                }
                for analysis in analyses
            ],
            "sheet": selected.name,
            "mode": mode,
            "columns": columns,
            "suggestedAColumn": selected.a_column if mode == "raw" else 0,
            "suggestedBColumn": selected.b_column if mode == "raw" else None,
            "sourceHasOnlyA": source_has_only_a,
            "preview": preview,
            "statistics": preliminary,
            "duplicates": duplicate_findings,
            "whitespaceFindings": whitespace_findings,
        }

    def mapping_options_response(
        self,
        importer: FileImporter,
        *,
        requested_sheet: str | None = None,
        requested_mode: str = "auto",
        a_column: int = 0,
        b_column: int = 1,
        query: str = "",
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Return selectable mappings from raw or formatted input."""

        selected, mode = self.choose(
            importer,
            requested_sheet=requested_sheet,
            requested_mode=requested_mode,
        )
        parser = MappingParser(
            auto_detect=True,
            allow_mixed_templates=True,
            allow_number_whitespace=True,
        )
        grouped: dict[str, list[str]] = {}
        seen_b: dict[str, set[str]] = {}

        if mode == "raw":
            header_pending = True
            for row in importer.iterateRows(selected.name):
                raw_a = row_value(row.values, a_column)
                raw_b = row_value(row.values, b_column)
                row_is_empty = (raw_a is None or not str(raw_a).strip()) and (
                    raw_b is None or not str(raw_b).strip()
                )
                if header_pending:
                    if row_is_empty:
                        continue
                    header_pending = False
                    if is_raw_header(row, a_column, b_column):
                        continue
                if row_is_empty:
                    continue
                try:
                    a_number = normalize_number(
                        raw_a,
                        source_row=row.source_row,
                        field="A",
                        allow_whitespace_error=True,
                    )
                    if not a_number:
                        raise AppError(
                            "INVALID_A_NUMBER",
                            "В строке отсутствует A-номер",
                            source_row=row.source_row,
                        )
                    b_number = normalize_number(
                        raw_b,
                        source_row=row.source_row,
                        field="B",
                        allow_whitespace_error=True,
                    )
                    if not b_number:
                        b_number = a_number
                except AppError as exc:
                    raise AppError(
                        "INVALID_RAW_FILE",
                        "Не удалось показать связки: проверьте значения "
                        "в колонках A и B",
                        source_row=exc.source_row,
                    ) from exc
                bucket = grouped.setdefault(a_number, [])
                known = seen_b.setdefault(a_number, set())
                if b_number not in known:
                    bucket.append(b_number)
                    known.add(b_number)
        else:
            for row in FormattedMappingImporter(importer).iterateRows(selected.name):
                raw_value = next(
                    (
                        value
                        for value in row.values
                        if value is not None and str(value).strip()
                    ),
                    None,
                )
                if raw_value is None or str(raw_value) == HEADER:
                    continue
                try:
                    parsed = parser.parse(str(raw_value), source_row=row.source_row)
                except AppError as exc:
                    raise AppError(
                        "INVALID_FORMATTED_FILE",
                        "Не удалось показать связки: готовый файл содержит "
                        "некорректную строку",
                        source_row=exc.source_row,
                    ) from exc
                bucket = grouped.setdefault(parsed.a_number, [])
                known = seen_b.setdefault(parsed.a_number, set())
                for b_number in parsed.b_numbers:
                    if b_number not in known:
                        bucket.append(b_number)
                        known.add(b_number)

        if not grouped or (mode == "formatted" and parser.detected_template is None):
            raise AppError(
                "NO_VALID_MAPPINGS",
                "Файл не содержит ни одной корректной связки",
            )

        normalized_query = query.strip()
        filtered = [
            (a_number, b_numbers)
            for a_number, b_numbers in grouped.items()
            if not normalized_query
            or normalized_query in a_number
            or any(normalized_query in b_number for b_number in b_numbers)
        ]
        page = filtered[offset : offset + limit]
        return {
            "items": [
                {"aNumber": a_number, "bNumbers": b_numbers}
                for a_number, b_numbers in page
            ],
            "total": len(filtered),
            "offset": offset,
            "limit": limit,
            "mode": mode,
            "sheet": selected.name,
        }
