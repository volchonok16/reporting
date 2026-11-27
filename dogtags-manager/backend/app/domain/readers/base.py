"""Shared immutable raw index for processing, review and correction; bounded verified fragments."""
import hashlib
import json
from bisect import bisect_right
from pathlib import Path
from uuid import UUID, uuid5

from app.domain.ingress import HUB_COLUMNS, SourceRecord
from app.storage.local import StorageFailure
from app.storage.json_objects import MAX_INDEX_BYTES, json_bytes, publish_json

RAW_VERSION = 'raw-table-v2'

def publish_raw_index(table, storage, directory, *, chunk_rows=1000):
    if chunk_rows < 1:
        raise ValueError('Chunk size must be positive.')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    chunks, pending = [], []
    def publish():
        item = publish_json(pending, directory / f'raw-{len(chunks)}.json', storage)
        chunks.append({**item, 'start': pending[0]['ordinal'], 'end': pending[-1]['ordinal']})
    for row in table.records():
        pending.append(row)
        if len(pending) >= chunk_rows:
            publish()
            pending = []
    if pending:
        publish()
    index = {'version': RAW_VERSION, 'reader_version': table.reader_version,
             'source_asset_id': str(table.source_id), 'table_id': table.table_id,
             'columns': table.columns, 'summary': table.summary, 'chunks': chunks}
    if len(json_bytes(index)) > MAX_INDEX_BYTES:
        raise ValueError('Raw index exceeds the configured metadata budget.')
    return publish_json(index, directory / 'raw-index.json', storage)['key']


def read_raw_index(storage, key):
    try:
        path = storage.path_for_key(key)
        size = path.stat().st_size
        if size > MAX_INDEX_BYTES:
            raise StorageFailure()
        index = json.loads(storage.verify(key, key.rsplit('/', 1)[-1], size).read_bytes())
        if index['version'] != RAW_VERSION:
            raise StorageFailure()
        previous = 0
        for chunk in index['chunks']:
            if chunk['start'] != previous + 1 or chunk['end'] < chunk['start']:
                raise StorageFailure()
            previous = chunk['end']
        if previous != index['summary']['parsed_records']:
            raise StorageFailure()
        return index
    except (OSError, ValueError, KeyError, TypeError):
        raise StorageFailure() from None


def raw_rows(storage, index, *, after=0, limit=None, fragment_cache=None):
    chunks = index['chunks']
    position = bisect_right([c['end'] for c in chunks], after)
    emitted = 0
    for chunk in chunks[position:]:
        try:
            rows = fragment_cache.get(chunk['key']) if fragment_cache is not None else None
            if rows is None:
                rows = json.loads(storage.verify(chunk['key'], chunk['sha256'], chunk['size_bytes']).read_bytes())
                if fragment_cache is not None:
                    fragment_cache.clear()  # At most one verified fragment per correction request.
                    fragment_cache[chunk['key']] = rows
            if len(rows) != chunk['end'] - chunk['start'] + 1:
                raise StorageFailure()
            for expected, row in enumerate(rows, chunk['start']):
                if row['ordinal'] != expected:
                    raise StorageFailure()
                if expected > after:
                    yield row
                    emitted += 1
                    if limit is not None and emitted >= limit:
                        return
        except (OSError, ValueError, KeyError, TypeError):
            raise StorageFailure() from None


def raw_page(storage, key, *, after=0, limit=50):
    if after < 0 or not 1 <= limit <= 500:
        raise ValueError('Invalid page request.')
    index = read_raw_index(storage, key)
    items = list(raw_rows(storage, index, after=after, limit=limit))
    last = items[-1]['ordinal'] if items else after
    return {'items': items, 'next_cursor': last if last < index['summary']['parsed_records'] else None}


def indexed_record_id(source_id, table_id, row_number):
    return str(uuid5(UUID(str(source_id)), f'table:{table_id}:row:{row_number}'))


def mapping_digest(key, mapping):
    return hashlib.sha256(json_bytes({'index': key, 'mapping': mapping})).hexdigest()


class MappedSource:
    def __init__(self, storage, key, source_id, mapping, *, required=HUB_COLUMNS, defaults=None):
        self.storage, self.key = storage, key
        self.index = read_raw_index(storage, key)
        if self.index['source_asset_id'] != str(source_id):
            raise StorageFailure()
        if (set(mapping) != set(required) or len(set(mapping.values())) != len(mapping)
                or any(type(i) is not int or not 0 <= i < len(self.index['columns']) for i in mapping.values())):
            raise ValueError('A complete unambiguous mapping is required.')
        self.mapping, self.source_id = mapping, source_id
        self.defaults = defaults or {}
        self.mapping_digest = mapping_digest(key, mapping)
        self.summary = {**self.index['summary'], 'raw_index_key': key,
                        'error_source': {'version': 'source-error-cells-v1',
                                         'columns': self.index['columns'], 'mapping': mapping},
                        'mapping_digest': self.mapping_digest, 'reader_version': self.index['reader_version']}

    def records(self, *, after=0, limit=None, fragment_cache=None):
        reverse_mapping = {column: field for field, column in self.mapping.items()}
        for row in raw_rows(self.storage, self.index, after=after, limit=limit, fragment_cache=fragment_cache):
            values = {**self.defaults, **{field: row['cells'][i] if i < len(row['cells']) else ''
                                         for field, i in self.mapping.items()}}
            issues = [{**issue, 'field': reverse_mapping[issue['column']]}
                      if 'column' in issue else issue for issue in row['issues']
                      if 'column' not in issue or issue['column'] in reverse_mapping]
            # Excel's display format cannot truncate the stored numeric INN.
            # Keep the format diagnostic in raw evidence, but validate the full
            # number normally. Scientific TEXT remains an error to exclude.
            metadata = row.get('cell_metadata', [])
            inn_column = self.mapping.get('INN')
            if (inn_column is not None and inn_column < len(metadata)
                    and metadata[inn_column].get('type') == 'number'):
                issues = [issue for issue in issues if not (
                    issue['field'] == 'INN' and issue['code'] == 'excel_scientific_notation')]
            yield SourceRecord(indexed_record_id(self.source_id, self.index['table_id'], row['row_number']),
                               row['ordinal'], row['line_start'], row['line_end'], row['cells'], values,
                               issues, self.mapping)
