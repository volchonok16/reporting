"""Read saved values from binary Excel workbooks, retaining worksheet coordinates."""
from contextlib import contextmanager
from datetime import date, time, timedelta
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from openpyxl.utils.cell import get_column_letter
from python_calamine import CalamineError, CalamineWorkbook, SheetTypeEnum, SheetVisibleEnum

from app.domain.readers.containers import CellBudget, ExcelLimits, WorkbookError, check_excel_zip
from app.domain.readers.empty_rows import empty_row, flag_columns
from app.domain.readers.excel_values import cell_value, discover_tables, raw_row, table_summary

LIMITATIONS = ['stored_values_only', 'formula_provenance_unavailable', 'cell_formats_unavailable',
               'sheet_loaded_in_memory']
VISIBILITY = ((SheetVisibleEnum.Visible, 'visible'), (SheetVisibleEnum.Hidden, 'hidden'),
              (SheetVisibleEnum.VeryHidden, 'veryHidden'))


def record_number(stream, first, limit):
    value = 0
    for index in range(limit):
        byte = first if index == 0 else stream.read(1)
        if not byte:
            break
        value |= (byte[0] & 127) << (7 * index)
        if byte[0] < 128:
            return value
    raise WorkbookError('excel_invalid_workbook', 'Повреждён заголовок записи XLSB.')


def check_binary_sheets(path, limits):
    with ZipFile(path) as archive:
        for member in archive.infolist():
            if not member.filename.startswith('xl/worksheets/') or not member.filename.endswith('.bin'):
                continue
            with archive.open(member) as stream:
                row, first_row, last_row, last_col = 0, None, 0, 0
                while first := stream.read(1):
                    kind = record_number(stream, first, 2)
                    size = record_number(stream, stream.read(1), 4)
                    end = stream.tell() + size
                    if end > member.file_size or (kind <= 11 and size < 4):
                        raise WorkbookError('excel_invalid_workbook', 'Повреждена запись листа XLSB.')
                    if 12 <= kind <= 18:
                        raise WorkbookError('xlsb_short_cells_unsupported',
                            'Книга использует сокращённые записи ячеек. Пересохраните её в Excel в формате XLSX.')
                    if kind == 0:
                        row = int.from_bytes(stream.read(4), 'little')
                    elif 1 <= kind <= 11:
                        col = int.from_bytes(stream.read(4), 'little')
                        if row >= 1048576 or col >= 16384:
                            raise WorkbookError('excel_invalid_coordinates', 'Ячейка за пределами XLSB.')
                        first_row = row if first_row is None else min(first_row, row)
                        last_row, last_col = max(last_row, row), max(last_col, col)
                        if (last_row - first_row + 1) * (last_col + 1) > limits.max_cells:
                            raise WorkbookError('excel_cell_limit', 'XLSB-лист превышает лимит ячеек.')
                    stream.seek(end)


@contextmanager
def book(path, limits):
    check_excel_zip(path, limits, 'xlsb')
    try:
        check_binary_sheets(path, limits)
        with Path(path).open('rb') as stream:
            workbook = CalamineWorkbook.from_filelike(stream)
            try:
                yield workbook
            finally:
                workbook.close()
    except (CalamineError, BadZipFile, OSError, ValueError, OverflowError) as error:
        if isinstance(error, WorkbookError):
            raise
        raise WorkbookError('excel_invalid_workbook', 'XLSB-книга повреждена или не поддерживается.') from None


def converted_rows(sheet, budget):
    if sheet.start is None or sheet.end is None:
        return
    start_row, start_col = sheet.start
    end_row, end_col = sheet.end
    if not 0 <= start_row <= end_row < 1048576 or not 0 <= start_col <= end_col < 16384:
        raise WorkbookError('excel_invalid_coordinates', 'Ячейка за пределами XLSB.')
    budget.add((end_row - start_row + 1) * (end_col + 1))
    for rn, row in enumerate(sheet.to_python(), start_row + 1):
        converted = []
        for cn, value in enumerate([''] * start_col + row, 1):
            kind = ('empty' if value == '' else 'boolean' if isinstance(value, bool)
                    else 'number' if isinstance(value, (int, float))
                    else 'date' if isinstance(value, (date, time, timedelta)) else 'text')
            metadata = {'coordinate': f'{get_column_letter(cn)}{rn}', 'type': kind,
                        'formula_provenance': 'unavailable_in_calamine'}
            text, issues = cell_value(str(value) if isinstance(value, timedelta) else value, metadata)
            if isinstance(value, timedelta):
                issues.append({'field': '', 'code': 'excel_date_cell',
                               'message': 'Ячейка распознана как время. Проверьте исходное значение.'})
            converted.append((text, metadata, issues))
        yield rn, converted


def discover_xlsb(path, aliases=None, *, limits=None, number_only=False):
    limits = limits or ExcelLimits()
    with book(path, limits) as workbook:
        budget = CellBudget(limits)
        sheets = ((sheet.name, next(name for state, name in VISIBILITY if state == sheet.visible),
                   converted_rows(workbook.get_sheet_by_name(sheet.name), budget))
                  for sheet in workbook.sheets_metadata if sheet.typ == SheetTypeEnum.WorkSheet)
        return {**discover_tables(sheets, aliases=aliases, number_only=number_only),
                'reader_version': XLSBTable.reader_version, 'limitations': LIMITATIONS}


class XLSBTable:
    reader_version = 'xlsb-table-v1'

    def __init__(self, path, source_id, *, sheet, header_row, end_row=None, limits=None):
        if not 1 <= header_row <= 1048576 or (end_row is not None and not header_row <= end_row <= 1048576):
            raise ValueError('Invalid Excel table range.')
        self.path, self.source_id, self.sheet = Path(path), source_id, sheet
        self.header_row, self.end_row, self.limits = header_row, end_row, limits or ExcelLimits()
        self.table_id, self.columns, self.summary = f'xlsb:{sheet}', [], {}

    def records(self):
        self.columns = []
        self.summary = table_summary(self.columns, sheet=self.sheet, header_row=self.header_row,
                                     end_row=self.end_row, limitations=LIMITATIONS)
        try:
            with book(self.path, self.limits) as workbook:
                flags = set()
                sheet = workbook.get_sheet_by_name(self.sheet)
                for rn, converted in converted_rows(sheet, CellBudget(self.limits)):
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
                    if not self.columns:
                        break
                    self.summary['ignored_extra_cells'] += max(0, len(converted) - len(self.columns))
                    converted = converted[:len(self.columns)]
                    if empty_row([cell[0] for cell in converted], flags) and not any(cell[2] for cell in converted):
                        self.summary['skipped_empty_rows'] += 1
                        continue
                    self.summary['parsed_records'] += 1
                    yield raw_row(rn, converted, self.summary['parsed_records'])
            self.summary['records_count'] = self.summary['parsed_records']
            if not self.summary['parsed_records']:
                self.summary['file_errors'].append({'field': '', 'code': 'source_empty', 'message': 'В таблице нет записей.'})
        except WorkbookError as error:
            self.summary['unknown_remainder'] = True
            self.summary['file_errors'].append({'field': '', 'code': error.code, 'message': error.message})
