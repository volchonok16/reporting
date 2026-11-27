"""CSV reader capacity follows accepted byte sizes without limiting field values."""
import csv
from threading import Lock

_field_limit_lock = Lock()


def ensure_csv_field_capacity(size_bytes):
    """A field can occupy the entire file; never shrink the process-wide reader limit."""
    with _field_limit_lock:
        required = size_bytes + 1
        if csv.field_size_limit() < required:
            csv.field_size_limit(required)
