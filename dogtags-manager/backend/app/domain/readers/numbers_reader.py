"""Saved Apple Numbers values; each table is a separate selectable source."""
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from warnings import catch_warnings, simplefilter
from zipfile import BadZipFile, ZipFile

from cramjam import DecompressionError, snappy
from google.protobuf.message import DecodeError
from numbers_parser import Document
from numbers_parser.exceptions import NumbersError, UnsupportedWarning
from openpyxl.utils.cell import get_column_letter

from app.domain.readers.containers import CellBudget, ExcelLimits, WorkbookError, check_size
from app.domain.readers.empty_rows import empty_row, flag_columns
from app.domain.readers.excel_values import cell_value, discover_tables, raw_row, table_summary

LIMITATIONS = ['stored_values_only', 'numbers_document_in_memory']
CELL_KINDS = {'NumberCell': 'number', 'TextCell': 'text', 'RichTextCell': 'text',
              'BoolCell': 'boolean', 'DateCell': 'date', 'EmptyCell': 'empty',
              'ErrorCell': 'error', 'MergedCell': 'empty'}


def check_expansion(archive, members, maximum):
    total = sum(member.file_size for member in members if not member.filename.endswith('.iwa'))
    for member in members:
        if not member.filename.endswith('.iwa'):
            continue
        with archive.open(member) as stream:
            while header := stream.read(4):
                if len(header) != 4 or header[0] != 0:
                    raise WorkbookError('numbers_invalid_container', 'Повреждён сжатый блок Numbers.')
                length = int.from_bytes(header[1:], 'little')
                payload = stream.read(length)
                if len(payload) != length or not payload:
                    raise WorkbookError('numbers_invalid_container', 'Сжатый блок Numbers прочитан не полностью.')
                try:
                    expanded = snappy.decompress_raw_len(payload)
                except DecompressionError:
                    expanded = length  # numbers-parser also accepts uncompressed IWA blocks.
                total += max(length, expanded)
                if total > maximum:
                    raise WorkbookError('excel_uncompressed_limit', 'Книга превышает бюджет распаковки.')


@contextmanager
def tables(path, limits):
    check_size(path, limits)
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            names = {member.filename for member in members}
            if len(members) > limits.max_members:
                raise WorkbookError('excel_member_limit', 'В книге слишком много ZIP-элементов.')
            if len(names) != len(members) or 'Index/Document.iwa' not in names:
                raise WorkbookError('numbers_invalid_container', 'Нет однозначной структуры книги Numbers.')
            if sum(member.file_size for member in members) > limits.max_uncompressed_bytes:
                raise WorkbookError('excel_uncompressed_limit', 'Книга превышает бюджет распаковки.')
            if any(member.flag_bits & 1 for member in members):
                raise WorkbookError('excel_encrypted', 'Сначала снимите пароль с книги Numbers.')
            check_expansion(archive, members, limits.max_uncompressed_bytes)
        with catch_warnings(), TemporaryDirectory(prefix='dogtags-numbers-') as temporary:
            simplefilter('error', UnsupportedWarning)
            # The library requires this suffix; stored originals use immutable SHA names.
            readable = Path(temporary) / 'source.numbers'
            readable.symlink_to(Path(path).resolve())
            document = Document(readable)
            selected, cells = {}, 0
            for si, sheet in enumerate(document.sheets, 1):
                for ti, table in enumerate(sheet.tables, 1):
                    cells += table.num_rows * table.num_cols
                    if cells > limits.max_cells:
                        raise WorkbookError('excel_cell_limit', 'Превышен лимит ячеек книги Numbers.')
                    key = f'{si}.{ti} — {sheet.name[:100]} / {table.name[:100]}'
                    selected[key] = table
            yield selected
    except WorkbookError:
        raise
    except (NumbersError, UnsupportedWarning, BadZipFile, DecodeError, OSError, EOFError,
            ValueError, KeyError, IndexError, TypeError, RuntimeError):
        raise WorkbookError('numbers_invalid_workbook',
            'Не удалось прочитать книгу Numbers. Проверьте файл и снимите пароль, если он установлен.') from None


def converted_rows(table, budget):
    for rn, row in enumerate(table.iter_rows(), 1):
        budget.add(len(row))
        converted = []
        for cn, cell in enumerate(row, 1):
            cell_class = type(cell).__name__
            kind = CELL_KINDS.get(cell_class, 'text')
            value = cell.value
            if isinstance(value, timedelta):
                value = str(value)
                kind = 'error'
            metadata = {'coordinate': f'{get_column_letter(cn)}{rn}', 'type': kind,
                        'formula': 'saved_numbers_formula' if cell.is_formula else None,
                        'formula_provenance': 'saved_result_only'}
            text, issues = cell_value(value, metadata)
            if cell_class == 'MergedCell':
                issues.append({'field': '', 'code': 'numbers_merged_cell',
                               'message': 'Объединённая ячейка: укажите значение для этой строки.'})
            converted.append((text, metadata, issues))
        yield rn, converted


def discover_numbers(path, aliases=None, *, limits=None, number_only=False):
    limits = limits or ExcelLimits()
    with tables(path, limits) as available:
        budget = CellBudget(limits)
        found = discover_tables(((key, 'visible', converted_rows(table, budget))
                                 for key, table in available.items()), aliases=aliases, number_only=number_only)
        return {**found, 'reader_version': NumbersTable.reader_version, 'limitations': LIMITATIONS}


class NumbersTable:
    reader_version = 'numbers-table-v1'

    def __init__(self, path, source_id, *, sheet, header_row, end_row=None, limits=None):
        if not 1 <= header_row <= 1_000_001 or (end_row is not None and not header_row <= end_row <= 1_000_001):
            raise ValueError('Invalid Numbers table range.')
        self.path, self.source_id, self.sheet = Path(path), source_id, sheet
        self.header_row, self.end_row = header_row, end_row
        self.limits = limits or ExcelLimits()
        self.table_id = f'numbers:{sheet}'
        self.columns, self.summary = [], {}

    def records(self):
        self.columns = []
        self.summary = table_summary(self.columns, sheet=self.sheet, header_row=self.header_row,
                                     end_row=self.end_row, limitations=LIMITATIONS)
        try:
            with tables(self.path, self.limits) as available:
                if self.sheet not in available:
                    raise WorkbookError('numbers_table_missing', 'Выбранная таблица Numbers отсутствует.')
                for rn, converted in converted_rows(available[self.sheet], CellBudget(self.limits)):
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
                    self.summary['parsed_records'] += 1
                    yield raw_row(rn, converted, self.summary['parsed_records'])
            self.summary['records_count'] = self.summary['parsed_records']
            if not self.summary['parsed_records']:
                self.summary['file_errors'].append({'field': '', 'code': 'source_empty', 'message': 'В таблице нет записей.'})
        except WorkbookError as error:
            self.summary['unknown_remainder'] = True
            self.summary['file_errors'].append({'field': '', 'code': error.code, 'message': error.message})
