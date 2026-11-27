"""Content identification and bounded preflight before an Excel parser sees uploaded bytes."""
from dataclasses import dataclass
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from defusedxml.ElementTree import iterparse
from defusedxml.common import DefusedXmlException
from xml.etree.ElementTree import ParseError


class WorkbookError(ValueError):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(f'{code}: {message}')


@dataclass(frozen=True)
class ExcelLimits:
    max_compressed_bytes: int = 256 * 1024 * 1024
    max_uncompressed_bytes: int = 1024 * 1024 * 1024
    max_members: int = 10000
    max_cells: int = 20_000_000
    # openpyxl retains shared strings; limit their input separately from streaming worksheets.
    max_shared_strings_bytes: int = 64 * 1024 * 1024

    def __post_init__(self):
        if min(vars(self).values()) <= 0:
            raise ValueError('Excel resource budgets must be positive.')

    @classmethod
    def from_settings(cls, settings):
        return cls(settings.max_upload_bytes, settings.excel_max_uncompressed_bytes,
                   settings.excel_max_members, settings.excel_max_cells,
                   settings.excel_max_shared_strings_bytes)


def detect_format(path):
    with Path(path).open('rb') as stream:
        signature = stream.read(8)
    if signature.startswith(b'PK\x03\x04'):
        try:
            with ZipFile(path) as archive:
                if 'Index/Document.iwa' in archive.namelist():
                    return 'numbers'
                if 'xl/workbook.bin' in archive.namelist():
                    return 'xlsb'
        except BadZipFile:
            pass
        return 'xlsx'
    if signature == bytes.fromhex('d0cf11e0a1b11ae1') or signature[:2] in (b'\x09\x00', b'\x09\x02', b'\x09\x04', b'\x09\x08'):
        return 'xls'
    return 'unknown'


def check_size(path, limits):
    if Path(path).stat().st_size > limits.max_compressed_bytes:
        raise WorkbookError('excel_compressed_limit', 'Книга превышает лимит исходных bytes.')


def check_xlsx(path, limits):
    check_excel_zip(path, limits, 'xlsx')


def check_excel_zip(path, limits, format_name):
    check_size(path, limits)
    if detect_format(path) != format_name:
        raise WorkbookError('excel_invalid_container', f'Содержимое не является незашифрованной {format_name.upper()}-книгой.')
    suffix = 'bin' if format_name == 'xlsb' else 'xml'
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > limits.max_members:
                raise WorkbookError('excel_member_limit', 'В книге слишком много ZIP-элементов.')
            if len({m.filename for m in members}) != len(members):
                raise WorkbookError('excel_invalid_container', 'Повторяющиеся имена ZIP-элементов неоднозначны.')
            if sum(m.file_size for m in members) > limits.max_uncompressed_bytes:
                raise WorkbookError('excel_uncompressed_limit', 'Книга превышает бюджет распаковки.')
            if not {'[Content_Types].xml', f'xl/workbook.{suffix}'} <= {m.filename for m in members}:
                raise WorkbookError('excel_invalid_container', f'Нет структуры {format_name.upper()}-книги.')
            for member in members:
                if member.flag_bits & 1:
                    raise WorkbookError('excel_encrypted', 'Зашифрованные книги требуют расшифровки пользователем.')
                if member.filename == f'xl/sharedStrings.{suffix}' and member.file_size > limits.max_shared_strings_bytes:
                    raise WorkbookError('excel_shared_strings_limit', 'Таблица общих строк превышает лимит памяти reader.')
                if member.filename.endswith(('.xml', '.rels')):
                    with archive.open(member) as stream:
                        # Defused iterparse forbids entities/external resolution; clearing bounds worksheet memory.
                        stack = []
                        for event, element in iterparse(stream, events=('start', 'end'), forbid_dtd=True):
                            if event == 'start':
                                # Validate actual cell positions, not the often incorrect dimension hint.
                                tag = element.tag.rsplit('}', 1)[-1]
                                if tag == 'row' and not 1 <= int(element.attrib.get('r', '1')) <= 1048576:
                                    raise WorkbookError('excel_invalid_coordinates', 'Номер строки за пределами XLSX.')
                                if tag == 'c' and 'r' in element.attrib:
                                    from openpyxl.utils.cell import coordinate_to_tuple
                                    row, column = coordinate_to_tuple(element.attrib['r'])
                                    if not 1 <= row <= 1048576 or not 1 <= column <= 16384:
                                        raise WorkbookError('excel_invalid_coordinates', 'Ячейка за пределами XLSX.')
                                stack.append(element)
                            else:
                                stack.pop()
                                if stack:
                                    stack[-1].remove(element)
                                element.clear()
    except WorkbookError:
        raise
    except (DefusedXmlException, ParseError):
        raise WorkbookError('excel_unsafe_xml', 'XML книги повреждён либо содержит запрещённые объявления.') from None
    except (BadZipFile, RuntimeError, OSError, EOFError, ValueError):
        raise WorkbookError('excel_invalid_container', 'ZIP-контейнер книги повреждён.') from None


class CellBudget:
    def __init__(self, limits):
        self.maximum, self.count = limits.max_cells, 0

    def add(self, cells):
        self.count += cells
        if self.count > self.maximum:
            raise WorkbookError('excel_cell_limit', 'Превышен лимит прочитанных ячеек; остаток не обработан.')
