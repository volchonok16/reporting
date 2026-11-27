"""Streaming XLSX saved-value reader; formula text is evidence, never executed."""
from contextlib import ExitStack, contextmanager
from itertools import zip_longest
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile
from defusedxml.ElementTree import iterparse

import openpyxl
from openpyxl.cell.cell import get_column_letter
from openpyxl.xml import DEFUSEDXML

from app.domain.readers.containers import CellBudget, ExcelLimits, WorkbookError, check_xlsx
from app.domain.readers.excel_values import cell_value, discover_tables, raw_row, table_summary
from app.domain.readers.empty_rows import empty_row, flag_columns

LIMITATIONS = ['stored_values_only', 'parsed_values_not_original_xml']


@contextmanager
def books(path, limits):
    check_xlsx(path, limits)
    if not DEFUSEDXML:
        raise WorkbookError('excel_xml_protection_missing', 'XML-защита reader не включена.')
    formula, cached = None, None
    try:
        with ExitStack() as files:
            # Stored originals have SHA filenames, not workbook extensions. Keep both streams alive.
            formula = openpyxl.load_workbook(files.enter_context(path.open('rb')), read_only=True, data_only=False, keep_links=False)
            cached = openpyxl.load_workbook(files.enter_context(path.open('rb')), read_only=True, data_only=True, keep_links=False)
            yield formula, cached
    except (BadZipFile, ParseError, KeyError, ValueError, OSError, EOFError) as error:
        if isinstance(error, WorkbookError):
            raise
        raise WorkbookError('excel_invalid_workbook', 'Структура XLSX-книги повреждена или не поддерживается.') from None
    finally:
        if formula:
            formula.close()
        if cached:
            cached.close()


def stored_number_rows(sheet):
    """Retain lexical numeric evidence lost by openpyxl's Python-number conversion.

    _get_source is the pinned 3.1.5 read-only worksheet stream, not a filesystem path.
    Keep only one row and detach parsed XML nodes to bound memory.
    """
    with sheet._get_source() as source:
        stack, numbers = [], {}
        for event, element in iterparse(source, events=('start', 'end'), forbid_dtd=True):
            tag = element.tag.rsplit('}', 1)[-1]
            if event == 'start':
                stack.append(element)
                continue
            parent = stack[-2] if len(stack) > 1 else None
            if tag == 'v' and parent is not None and parent.tag.rsplit('}', 1)[-1] == 'c':
                if parent.attrib.get('t', 'n') == 'n':
                    numbers[parent.attrib.get('r')] = element.text
            if tag == 'row':
                yield int(element.attrib['r']), numbers
                numbers = {}
            stack.pop()
            if parent is not None:
                parent.remove(element)
            element.clear()


def converted_rows(sheet, cached, budget):
    # Dimensions are untrusted producer hints. Read all actual rows, including those outside the hint.
    sheet.reset_dimensions()
    cached.reset_dimensions()
    numeric_rows = stored_number_rows(sheet)
    numeric_row = next(numeric_rows, None)
    for rn, (formulas, values) in enumerate(zip_longest(sheet.iter_rows(), cached.iter_rows(), fillvalue=()), 1):
        budget.add(max(len(formulas), len(values), 1))
        numbers = {}
        if numeric_row is not None and numeric_row[0] == rn:
            numbers = numeric_row[1]
            numeric_row = next(numeric_rows, None)
        converted = []
        for cn, (cell, saved) in enumerate(zip_longest(formulas, values), 1):
            formula = cell.value if cell is not None and cell.data_type == 'f' else None
            value = saved.value if formula is not None and saved is not None else (cell.value if cell is not None else None)
            data_type = (saved.data_type if formula is not None and saved is not None else getattr(cell, 'data_type', 'n'))
            if formula is not None and not isinstance(formula, str):
                formula = {'type': getattr(formula, 't', 'unknown'),
                           'text': getattr(formula, 'text', None), **dict(formula)}
            metadata = {'coordinate': f'{get_column_letter(cn)}{rn}', 'type': {
                'n': 'number', 's': 'text', 'str': 'text', 'inlineStr': 'text', 'b': 'boolean',
                'd': 'date', 'e': 'error'}.get(data_type, data_type),
                'number_format': getattr(cell, 'number_format', 'General'), 'formula': formula,
                'cached_value': value if formula is not None and isinstance(value, (str, int, float, bool)) else None,
                'formula_provenance': 'available',
                'stored_numeric_text': numbers.get(f'{get_column_letter(cn)}{rn}')}
            text, issues = cell_value(value, metadata)
            converted.append((text, metadata, issues))
        yield rn, converted


def discover_xlsx(path, aliases=None, *, limits=None, number_only=False):
    limits = limits or ExcelLimits()
    with books(Path(path), limits) as (formula, cached):
        budget = CellBudget(limits)
        result = discover_tables(((sheet.title, sheet.sheet_state,
                                   converted_rows(sheet, cached[sheet.title], budget)) for sheet in formula),
                                 aliases=aliases, number_only=number_only)
        return {**result, 'reader_version': XLSXTable.reader_version, 'limitations': LIMITATIONS}


class XLSXTable:
    reader_version = 'xlsx-table-v4'

    def __init__(self, path, source_id, *, sheet, header_row, end_row=None, limits=None):
        if not 1 <= header_row <= 1048576 or (end_row is not None and not header_row <= end_row <= 1048576):
            raise ValueError('Invalid Excel table range.')
        self.path, self.source_id, self.sheet = Path(path), source_id, sheet
        self.header_row, self.end_row = header_row, end_row
        self.limits = limits or ExcelLimits()
        self.table_id = f'xlsx:{sheet}'
        self.columns, self.summary = [], {}

    def records(self):
        self.columns = []
        self.summary = table_summary(self.columns, sheet=self.sheet, header_row=self.header_row,
                                     end_row=self.end_row, limitations=LIMITATIONS)
        try:
            with books(self.path, self.limits) as (formula, cached):
                if self.sheet not in formula.sheetnames:
                    raise WorkbookError('excel_sheet_missing', 'Выбранный лист отсутствует.')
                for rn, converted in converted_rows(formula[self.sheet], cached[self.sheet], CellBudget(self.limits)):
                    if rn < self.header_row:
                        continue
                    if self.end_row is not None and rn > self.end_row:
                        break
                    if rn == self.header_row:
                        self.columns.extend(cell[0] for cell in converted)
                        while self.columns and not self.columns[-1]:
                            self.columns.pop()
                        flags = flag_columns(self.columns)
                        continue
                    if len(converted) > len(self.columns):
                        self.summary['ignored_extra_cells'] += len(converted) - len(self.columns)
                        converted = converted[:len(self.columns)]
                    if empty_row([cell[0] for cell in converted], flags) and not any(cell[2] for cell in converted):
                        self.summary['skipped_empty_rows'] += 1
                        continue
                    record = raw_row(rn, converted, self.summary['parsed_records'] + 1)
                    # Excel omits trailing empty cells from row XML; these are known empty, not lost fields.
                    while len(record['cells']) < len(self.columns):
                        record['cells'].append('')
                        record['cell_metadata'].append({'type': 'empty', 'coordinate': f'{get_column_letter(len(record["cells"]))}{rn}', 'issues': []})
                    self.summary['parsed_records'] += 1
                    yield record
            self.summary['records_count'] = self.summary['parsed_records']
            if not self.summary['parsed_records']:
                self.summary['file_errors'].append({'field': '', 'code': 'source_empty', 'message': 'В таблице нет записей.'})
        except WorkbookError as error:
            self.summary['unknown_remainder'] = True
            self.summary['file_errors'].append({'field': '', 'code': error.code, 'message': error.message})
