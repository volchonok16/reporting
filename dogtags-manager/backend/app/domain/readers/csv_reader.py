"""Strict CSV candidates and streaming raw records, independent of business column order."""
import csv
import hashlib
import json

from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.ingress import physical_lines
from app.domain.readers.mapping import map_columns
from app.domain.validation import LABEL_ALPHABETS, label_script_valid
from app.domain.readers.empty_rows import empty_row, flag_columns
from app.domain.rules import ordinary_spaces


class CSVTable:
    reader_version = 'csv-table-v4'
    table_id = 'CSV'

    def __init__(self, path, source_id, *, encoding, delimiter):
        if encoding not in ('utf-8', 'utf-8-sig', 'cp1251') or delimiter not in (';', ',', '\t', '|'):
            raise ValueError('Unsupported CSV reading selection.')
        self.path, self.source_id, self.encoding, self.delimiter = path, source_id, encoding, delimiter
        self.summary = {}
        self.columns = []

    def records(self):
        ensure_csv_field_capacity(self.path.stat().st_size)
        self.summary = {'columns': [], 'parsed_records': 0, 'records_count': None,
                        'unknown_remainder': False, 'file_errors': [], 'schema_supported': True, 'skipped_empty_rows': 0, 'ignored_extra_cells': 0}
        reader = None
        try:
            lines = physical_lines(self.path, 'utf-8' if self.encoding == 'utf-8-sig' else self.encoding)
            stream = (line.removeprefix('\ufeff') if i == 0 and self.encoding == 'utf-8-sig' else line
                      for i, line in enumerate(lines))
            reader = csv.reader(stream, delimiter=self.delimiter, strict=True)
            self.columns = next(reader, [])
            self.summary['columns'] = self.columns
            flags = flag_columns(self.columns)
            ordinal = 0
            while True:
                start = reader.line_num + 1
                cells = next(reader, None)
                if cells is None:
                    break
                if len(cells) > len(self.columns):
                    self.summary['ignored_extra_cells'] += len(cells) - len(self.columns)
                    cells = cells[:len(self.columns)]
                if empty_row(cells, flags):
                    self.summary['skipped_empty_rows'] += 1
                    continue
                ordinal += 1
                issues = []
                if len(cells) != len(self.columns):
                    issues.append({'field': '', 'code': 'row_shape',
                                   'message': 'Число ячеек отличается от заголовка; исходные ячейки сохранены.'})
                if cells == self.columns:
                    issues.append({'field': '', 'code': 'repeated_header',
                                   'message': 'В данных повторяется строка заголовков. Требуется разбор.'})
                self.summary['parsed_records'] = ordinal
                yield {'ordinal': ordinal, 'row_number': start, 'line_start': start,
                       'line_end': reader.line_num, 'cells': cells, 'issues': issues,
                       'cell_metadata': [{'type': 'text'} for _ in cells]}
            self.summary['records_count'] = ordinal
            if not ordinal:
                self.summary['file_errors'].append({'field': '', 'code': 'source_empty',
                                                   'message': 'В таблице нет записей.'})
        except (UnicodeError, csv.Error) as error:
            self.summary['unknown_remainder'] = True
            self.summary['file_errors'].append({'field': '', 'code': (
                'source_encoding_error' if isinstance(error, UnicodeError) else 'source_csv_syntax_error'),
                'message': 'Чтение таблицы прервано; непрочитанный остаток требует проверки.'})


def discover_csv(path, aliases=None, *, returned=False, number_only=False):
    """Full strict candidate reads; equivalent interpretations collapse, ambiguity stays visible."""
    with path.open('rb') as stream:
        bom = stream.read(3) == b'\xef\xbb\xbf'
    encodings = ['utf-8-sig'] if bom else ['utf-8', 'cp1251']
    choices, signatures = [], set()
    for encoding in encodings:
        for delimiter in (';', ',', '\t', '|'):
            table = CSVTable(path, None, encoding=encoding, delimiter=delimiter)
            digest = hashlib.sha256()
            row_issues, script_errors, mapped = 0, 0, None
            for row in table.records():
                if mapped is None:
                    if len(table.columns) == 1 and map_columns(table.columns, aliases, ('MSISDN',))['missing']:
                        break  # This header cannot be a candidate; don't scan the remainder for a wrong separator.
                    mapped = map_columns(table.columns, aliases)['mapping']
                number = mapped.get('MSISDN')
                compared = [row['cells'][number]] if number_only and number is not None and number < len(row['cells']) else row['cells']
                digest.update(json.dumps(compared, ensure_ascii=False).encode())
                row_issues += len(row['issues'])
                for field in LABEL_ALPHABETS:
                    column = mapped.get(field)
                    if column is not None and column < len(row['cells']):
                        script_errors += not label_script_valid(field, ordinary_spaces(row['cells'][column]))
            columns = table.columns
            if not columns or (len(columns) == 1 and map_columns(columns, aliases, ('MSISDN',))['missing']):
                continue
            signature = ((('MSISDN', map_columns(columns, aliases, ('MSISDN',))['mapping']['MSISDN'])
                          if number_only and map_columns(columns, aliases, ('MSISDN',))['complete'] else tuple(columns)), digest.hexdigest(), tuple(e['code'] for e in table.summary['file_errors']))
            if signature in signatures:
                continue
            signatures.add(signature)
            mapping = map_columns(columns, aliases, ('MSISDN',)) if number_only else map_columns(columns, aliases)
            choices.append({'reader': {'encoding': encoding, 'delimiter': delimiter}, 'columns': columns,
                            'mapping': mapping, 'summary': table.summary,
                            'row_issues': row_issues, 'label_script_errors': script_errors})
    # Known headers may resolve decoding/separator ambiguity; bad values still go through validation.
    recognizable = [c for c in choices if c['mapping']['complete'] or
                    (len(c['columns']) == 1 and map_columns(c['columns'], aliases, ('MSISDN',))['complete'])]
    candidates = recognizable or choices
    readable = [c for c in candidates if not c['summary']['unknown_remainder']]
    candidates = readable or candidates
    if len(candidates) > 1:
        compatible = [c for c in candidates if c['label_script_errors'] == 0
                      and (set(LABEL_ALPHABETS) <= set(c['mapping']['mapping']) or
                           returned and bool(set(LABEL_ALPHABETS) & set(c['mapping']['mapping'])))]
        if len(compatible) == 1:
            return compatible
    return candidates
