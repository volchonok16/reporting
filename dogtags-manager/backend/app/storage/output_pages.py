"""Preview pages are derived from verified CSV bytes, then bound by the artifact manifest."""
import csv
import hashlib
import json
from itertools import zip_longest

from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.output_spec import file_definition
from app.domain.serialization import csv_bytes, csv_header_bytes, csv_read_encoding
from app.storage.local import StorageFailure
from app.storage.pages import publish_pages, read_fragment, read_page


def csv_rows(path, obj, operation, *, error_source=None):
    ensure_csv_field_capacity(obj.size_bytes)
    definition = file_definition(obj.role, operation, error_source=error_source)
    with path.open(encoding=csv_read_encoding(definition), errors='strict', newline='') as stream:
        reader = csv.reader(stream, delimiter=';', strict=True)
        if next(reader, None) != definition['columns']:
            raise StorageFailure()
        for row in reader:
            if len(row) != len(definition['columns']):
                raise StorageFailure()
            for field, value in zip(definition['columns'], row, strict=True):
                if (field in definition['required'] and value == '' or
                        field in definition.get('constants', {}) and value != definition['constants'][field]):
                    raise StorageFailure()
            yield row


def publish_output_pages(files, directory, storage, operation, *, dataset=None):
    layout = dataset.summary.get('error_source') if dataset else None
    def rows(obj):
        diagnostics = None
        if obj.role in ('ERRORS', 'ERROR_OTHER_OPERATOR') and layout:
            from app.domain.error_exports import preview_diagnostics
            diagnostics = iter(preview_diagnostics(dataset, obj.role))
        for n, values in enumerate(csv_rows(obj.path, obj, operation, error_source=layout), 1):
            row = {'page_index': n, 'values': values}
            if diagnostics is not None:
                row['diagnostics'] = next(diagnostics)
            yield row
        if diagnostics is not None and next(diagnostics, None) is not None:
            raise StorageFailure()
    return {obj.role: publish_pages(rows(obj), directory, storage, role=f'output-{obj.role}', chunk_bytes=1024 * 1024)
            for obj in files}


def preview_page(storage, descriptor, role, *, after=0, limit=50):
    return read_page(storage, descriptor, f'output-{role}', after=after, limit=limit)


def verify_output_pages(storage, descriptor, obj, operation, *, error_source=None):
    """Full verification at publication/approval/download, including preview-to-CSV equality."""
    path = storage.verify(descriptor['key'], descriptor['sha256'], descriptor['size_bytes'])
    index = json.loads(path.read_bytes())
    if index['version'] != 'verified-pages-v1' or index['role'] != f'output-{obj.role}':
        raise StorageFailure()
    def rows():
        ordinal = 0
        for chunk in index['chunks']:
            data = read_fragment(storage, chunk)
            if not data or chunk['start'] != ordinal + 1 or chunk['end'] != ordinal + len(data):
                raise StorageFailure()
            for row in data:
                ordinal += 1
                if row['page_index'] != ordinal:
                    raise StorageFailure()
                yield row['values']
    definition = file_definition(obj.role, operation, error_source=error_source)
    encoding = definition.get('encoding', 'cp1251')
    digest = hashlib.sha256(csv_header_bytes(definition))
    count = 0
    for original, preview in zip_longest(csv_rows(storage.path_for_key(obj.storage_key), obj, operation,
                                                error_source=error_source), rows()):
        if original != preview or original is None:
            raise StorageFailure()
        count += 1
        digest.update(csv_bytes(original, encoding))
    if count != obj.row_count or digest.hexdigest() != obj.sha256:
        raise StorageFailure()
