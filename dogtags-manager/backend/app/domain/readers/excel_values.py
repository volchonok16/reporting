"""Saved Excel values, explicit uncertainty, and common table discovery (no calculation)."""
from datetime import date, datetime, time
import math
import re

from app.domain.ingress import HUB_COLUMNS
from app.domain.readers.mapping import effective_aliases, header_key, map_columns


def cell_value(value, metadata):
    issues = []
    def issue(code, message):
        issues.append({'field': '', 'code': code, 'message': message})
    kind = metadata['type']
    if metadata.get('formula') is not None and value is None:
        issue('excel_formula_cache_missing', 'У формулы нет сохранённого результата; укажите подтверждённое значение.')
    if kind == 'error':
        issue('excel_error', 'Ячейка содержит ошибку Excel; требуется исправление.')
    if value is None:
        text = ''
    elif isinstance(value, bool):
        text = '1' if value else '0'
    elif isinstance(value, (int, float)):
        if not math.isfinite(value) or not float(value).is_integer() or abs(value) > 999_999_999_999_999:
            issue('excel_numeric_precision', 'Число не является достоверным целым до 15 цифр; исходный идентификатор нельзя восстановить.')
        text = str(int(value)) if math.isfinite(value) and float(value).is_integer() else str(value)
        if (re.search(r'[eE][+-]0', metadata.get('number_format', ''))
                or re.search(r'[eE]', metadata.get('stored_numeric_text') or '')):
            issue('excel_scientific_notation', 'Числовая ячейка использует научную запись; требуется проверка идентификатора.')
    elif isinstance(value, (date, datetime, time)):
        text = value.isoformat()
        issue('excel_date_cell', 'Ячейка распознана как дата или время; требуется проверка исходного значения.')
    else:
        text = str(value)
        if re.fullmatch(r'[+-]?\d+(?:[.,]\d+)?[eE][+-]?\d+', text.strip()):
            issue('excel_scientific_notation', 'Текст содержит научную запись; идентификатор не восстанавливается догадкой.')
    metadata['parsed_value'] = value.isoformat() if isinstance(value, (date, datetime, time)) else value
    for field in ('parsed_value', 'cached_value'):
        saved = metadata.get(field)
        if isinstance(saved, float) and not math.isfinite(saved):
            metadata[field] = str(saved)
    metadata['issues'] = issues
    return text, issues


def raw_row(row_number, converted, ordinal):
    cells, metadata, issues = [], [], []
    for column, (text, meta, cell_issues) in enumerate(converted):
        cells.append(text)
        metadata.append(meta)
        issues.extend({**issue, 'column': column} for issue in cell_issues)
    return {'ordinal': ordinal, 'row_number': row_number, 'line_start': row_number,
            'line_end': row_number, 'cells': cells, 'cell_metadata': metadata, 'issues': issues}


def table_summary(columns, *, sheet, header_row, end_row, limitations):
    return {'columns': columns, 'parsed_records': 0, 'records_count': None, 'unknown_remainder': False,
            'file_errors': [], 'schema_supported': True, 'sheet': sheet, 'header_row': header_row,
            'end_row': end_row, 'limitations': limitations, 'skipped_empty_rows': 0, 'ignored_extra_cells': 0}


def discover_tables(sheets, *, aliases=None, number_only=False):
    """Scan every sheet, including hidden sheets and headings below titles; never merge sheets."""
    inventory, candidates = [], []
    aliases = effective_aliases(aliases)
    header_names = {header_key(name) for field in (*HUB_COLUMNS, 'STATUS') for name in (field, *aliases.get(field, []))}
    for name, state, rows in sheets:
        headers, first, last, width = [], None, None, 0
        for row_number, converted in rows:
            cells = [cell[0] for cell in converted]
            if any(cells):
                first = first or row_number
                last = row_number
                width = max(width, len(cells))
            if not any(header_key(cell) in header_names for cell in cells):
                continue
            mapping = map_columns(cells, aliases)
            matched = len(mapping['mapping']) + len(mapping['ambiguous'])
            status = map_columns(cells, aliases, ('STATUS',))['complete']
            if number_only and map_columns(cells, aliases, ('MSISDN',))['complete'] or matched >= 2 or status or (matched == 1 and len([cell for cell in cells if cell]) == 1):
                headers.append((row_number, cells, mapping))
        inventory.append({'sheet': name, 'state': state, 'first_row': first, 'last_row': last,
                          'columns_count': width, 'candidate_count': len(headers)})
        for index, (row_number, cells, mapping) in enumerate(headers):
            end = headers[index + 1][0] - 1 if index + 1 < len(headers) else last
            candidates.append({'reader': {'sheet': name, 'header_row': row_number, 'end_row': end},
                               'columns': cells, 'mapping': mapping, 'state': state})
    return {'inventory': inventory, 'candidates': candidates}
