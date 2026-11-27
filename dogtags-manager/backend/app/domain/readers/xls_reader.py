"""Legacy XLS saved values. xlrd cannot identify every formula cache as a formula."""
from contextlib import contextmanager
from io import StringIO
from pathlib import Path
import struct

import xlrd
from xlrd.compdoc import CompDocError
from openpyxl.utils.cell import get_column_letter

from app.domain.readers.containers import CellBudget, ExcelLimits, WorkbookError, check_size, detect_format
from app.domain.readers.excel_values import cell_value, discover_tables, raw_row, table_summary
from app.domain.readers.empty_rows import empty_row, flag_columns

LIMITATIONS = ['stored_values_only', 'formula_provenance_unavailable', 'parsed_values_not_original_biff',
               'sheet_loaded_in_memory']


@contextmanager
def book(path, limits):
    check_size(path, limits)
    if detect_format(path) != 'xls':
        raise WorkbookError('excel_invalid_container', 'Содержимое не является XLS-книгой.')
    workbook = None
    try:
        workbook = xlrd.open_workbook(path, on_demand=True, formatting_info=True, logfile=StringIO())
        yield workbook
    except WorkbookError:
        raise
    except (xlrd.XLRDError, CompDocError, ValueError, IndexError, struct.error, OSError, AssertionError):
        raise WorkbookError('excel_invalid_workbook', 'XLS-книга повреждена, зашифрована или не поддерживается.') from None
    finally:
        if workbook:
            workbook.release_resources()


def converted_rows(workbook, sheet, budget):
    for rn in range(sheet.nrows):
        budget.add(sheet.ncols)
        converted = []
        for cn in range(sheet.ncols):
            cell = sheet.cell(rn, cn)
            format_string = workbook.format_map[workbook.xf_list[cell.xf_index].format_key].format_str
            kind = {xlrd.XL_CELL_EMPTY: 'empty', xlrd.XL_CELL_TEXT: 'text', xlrd.XL_CELL_NUMBER: 'number',
                    xlrd.XL_CELL_DATE: 'date', xlrd.XL_CELL_BOOLEAN: 'boolean',
                    xlrd.XL_CELL_ERROR: 'error', xlrd.XL_CELL_BLANK: 'empty'}[cell.ctype]
            value = cell.value
            if kind == 'error':
                value = xlrd.error_text_from_code.get(value, str(value))
            elif kind == 'date':
                try:
                    value = xlrd.xldate_as_datetime(value, workbook.datemode)
                except (ValueError, OverflowError):
                    kind = 'error'
            elif kind == 'boolean':
                value = bool(value)
            metadata = {'coordinate': f'{get_column_letter(cn + 1)}{rn + 1}', 'type': kind,
                        'number_format': format_string, 'formula_provenance': 'unavailable_in_xlrd'}
            text, issues = cell_value(value, metadata)
            converted.append((text, metadata, issues))
        yield rn + 1, converted


def discover_xls(path, aliases=None, *, limits=None, number_only=False):
    limits = limits or ExcelLimits()
    with book(path, limits) as workbook:
        budget = CellBudget(limits)
        def sheets():
            for index, name in enumerate(workbook.sheet_names()):
                sheet = workbook.sheet_by_index(index)
                try:
                    # xlrd materializes a sheet. Check dimensions immediately before iterating its cells.
                    if sheet.nrows * sheet.ncols > limits.max_cells - budget.count:
                        raise WorkbookError('excel_cell_limit', 'XLS-лист превышает лимит ячеек.')
                    yield name, {0: 'visible', 1: 'hidden', 2: 'veryHidden'}.get(sheet.visibility, 'hidden'), converted_rows(workbook, sheet, budget)
                finally:
                    workbook.unload_sheet(index)
        return {**discover_tables(sheets(), aliases=aliases, number_only=number_only), 'reader_version': XLSTable.reader_version,
                'limitations': LIMITATIONS}


class XLSTable:
    reader_version = 'xls-table-v4'

    def __init__(self, path, source_id, *, sheet, header_row, end_row=None, limits=None):
        if not 1 <= header_row <= 65536 or (end_row is not None and not header_row <= end_row <= 65536):
            raise ValueError('Invalid Excel table range.')
        self.path, self.source_id, self.sheet = Path(path), source_id, sheet
        self.header_row, self.end_row, self.limits = header_row, end_row, limits or ExcelLimits()
        self.table_id, self.columns, self.summary = f'xls:{sheet}', [], {}

    def records(self):
        self.columns = []
        self.summary = table_summary(self.columns, sheet=self.sheet, header_row=self.header_row,
                                     end_row=self.end_row, limitations=LIMITATIONS)
        try:
            with book(self.path, self.limits) as workbook:
                sheet = workbook.sheet_by_name(self.sheet)
                for rn, converted in converted_rows(workbook, sheet, CellBudget(self.limits)):
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
                    self.summary['parsed_records'] += 1
                    yield record
            self.summary['records_count'] = self.summary['parsed_records']
            if not self.summary['parsed_records']:
                self.summary['file_errors'].append({'field': '', 'code': 'source_empty', 'message': 'В таблице нет записей.'})
        except WorkbookError as error:
            self.summary['unknown_remainder'] = True
            self.summary['file_errors'].append({'field': '', 'code': error.code, 'message': error.message})
