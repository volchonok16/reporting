"""Immutable page fragments; deep previews verify only their index and selected chunks."""
import json
import hashlib
import os
from bisect import bisect_right

from app.domain.ingress import HUB_COLUMNS
from app.storage.json_objects import MAX_INDEX_BYTES, json_bytes, publish_json
from app.storage.local import StagedObject, StorageFailure


def publish_pages(rows, directory, storage, *, role, chunk_rows=1000, chunk_bytes=None):
    chunks, pending = [], []
    def flush():
        path = directory / f'page-{role}-{len(chunks)}.json'
        descriptor = publish_fragment(pending, path, storage, chunk_bytes)
        chunks.append({**descriptor, 'start': pending[0]['page_index'], 'end': pending[-1]['page_index'],
                       'ordinal_start': pending[0].get('ordinal'), 'ordinal_end': pending[-1].get('ordinal')})
    pending_bytes = 0
    for row in rows:
        row_bytes = len(json_bytes(row)) if chunk_bytes else 0
        if pending and chunk_bytes and pending_bytes + row_bytes > chunk_bytes:
            flush()
            pending, pending_bytes = [], 0
        pending.append(row)
        pending_bytes += row_bytes
        if len(pending) >= chunk_rows:
            flush()
            pending, pending_bytes = [], 0
    if pending:
        flush()
    index = {'version': 'verified-pages-v1', 'role': role, 'chunks': chunks}
    if len(json_bytes(index)) > MAX_INDEX_BYTES:
        raise ValueError('Preview index exceeds metadata budget.')
    return publish_json(index, directory / f'pages-{role}.json', storage)


def read_page(storage, descriptor, role, *, after=0, limit=50, record_id=None, ordinal=None, record_fields=HUB_COLUMNS):
    if after < 0 or not 1 <= limit <= 500:
        raise ValueError('Invalid page request.')
    try:
        if descriptor['size_bytes'] > MAX_INDEX_BYTES:
            raise StorageFailure()
        path = storage.verify(descriptor['key'], descriptor['sha256'], descriptor['size_bytes'])
        index = json.loads(path.read_bytes())
        if index['version'] != 'verified-pages-v1' or index['role'] != role:
            raise StorageFailure()
        chunks, items = index['chunks'], []
        if record_id:
            if ordinal is None:
                raise ValueError('A source ordinal is required for bounded record lookup.')
            start = bisect_right([c['ordinal_end'] for c in chunks], ordinal - 1)
        else:
            start = bisect_right([c['end'] for c in chunks], after)
        for chunk in chunks[start:]:
            if record_id and chunk['ordinal_start'] > ordinal:
                break
            for row in read_fragment(storage, chunk):
                if row['page_index'] <= after or (record_id and row['record_id'] != record_id):
                    continue
                items.append(row)
                if len(items) > limit:
                    break
            if len(items) > limit:
                break
        result = items[:limit]
        for row in result:
            if role in ('records', 'records-errors-first'):
                row['effective'] = {field: row.pop(field) for field in record_fields}
            row.pop('effective_cells', None)
        return {'items': result, 'next_cursor': result[-1]['page_index'] if len(items) > limit else None}
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        raise StorageFailure() from None


def publish_fragment(rows, path, storage, byte_limit=None):
    if byte_limit is None:
        return publish_json(rows, path, storage)
    data = json_bytes(rows)
    if len(data) <= byte_limit:
        return publish_json(rows, path, storage)
    parts = []
    for offset in range(0, len(data), byte_limit):
        payload = data[offset:offset + byte_limit]
        digest = hashlib.sha256(payload).hexdigest()
        part_path = path.with_name(f'{path.stem}-part-{len(parts)}.json')
        with part_path.open('xb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        key = storage.publish(StagedObject(part_path, digest, len(payload)))
        part_path.unlink()
        parts.append({'key': key, 'sha256': digest, 'size_bytes': len(payload)})
    return {'parts': parts}


def read_fragment(storage, descriptor):
    if 'parts' in descriptor:
        data = b''.join(storage.verify(p['key'], p['sha256'], p['size_bytes']).read_bytes()
                        for p in descriptor['parts'])
    else:
        data = storage.verify(descriptor['key'], descriptor['sha256'], descriptor['size_bytes']).read_bytes()
    return json.loads(data)


def read_owned_issue_rows(storage, descriptor, records):
    """Read only verified fragments intersecting this bounded page of identities."""
    result = {row['record_id']: [] for row in records}
    if not records:
        return {}
    identities = {row['ordinal']: row['record_id'] for row in records}
    first, last = min(identities), max(identities)
    try:
        if descriptor['size_bytes'] > MAX_INDEX_BYTES:
            raise StorageFailure()
        path = storage.verify(descriptor['key'], descriptor['sha256'], descriptor['size_bytes'])
        index = json.loads(path.read_bytes())
        if index['version'] != 'verified-pages-v1' or index['role'] != 'issues':
            raise StorageFailure()
        chunks = index['chunks']
        start = bisect_right([chunk['ordinal_end'] for chunk in chunks], first - 1)
        for chunk in chunks[start:]:
            if chunk['ordinal_start'] > last:
                break
            for issue in read_fragment(storage, chunk):
                if identities.get(issue['ordinal']) == issue['record_id']:
                    result[issue['record_id']].append(issue)
        return result
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        raise StorageFailure() from None


def read_issue_fields(storage, descriptor, records):
    return {record_id: sorted({issue['field'] for issue in rows})
            for record_id, rows in read_owned_issue_rows(storage, descriptor, records).items()}


def group_record_issues(records, issues):
    """Keep exact diagnostics once and field pairs in a stable display order."""
    grouped = {row['record_id']: set() for row in records}
    identities = {row['ordinal']: row['record_id'] for row in records}
    keys = ('field', 'scope', 'code', 'message')
    for issue in issues:
        if identities.get(issue['ordinal']) == issue['record_id']:
            grouped[issue['record_id']].add(tuple(issue[key] for key in keys))
    return {record_id: [dict(zip(keys, values, strict=True)) for values in sorted(rows)]
            for record_id, rows in grouped.items()}


def read_record_issues(storage, descriptor, records):
    rows = read_owned_issue_rows(storage, descriptor, records)
    try:
        return group_record_issues(records, (issue for items in rows.values() for issue in items))
    except (KeyError, TypeError, ValueError):
        raise StorageFailure() from None
