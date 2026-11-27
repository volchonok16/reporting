"""Durable content-addressed JSON objects shared by immutable indexes."""
import hashlib
import json
import os

from app.storage.local import StagedObject

MAX_INDEX_BYTES = 16 * 1024 * 1024


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def publish_json(value, path, storage):
    data = json_bytes(value)
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    digest = hashlib.sha256(data).hexdigest()
    key = storage.publish(StagedObject(path, digest, len(data)))
    path.unlink()
    return {'key': key, 'sha256': digest, 'size_bytes': len(data)}


