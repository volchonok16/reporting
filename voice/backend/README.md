# A/B Mapping API

FastAPI backend for safe conversion and editing of A/B-number mappings.

## Local run

From the repository root:

```bash
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Every endpoint except `/api/health` requires a non-empty `X-Session-ID`.
OpenAPI is available at `http://127.0.0.1:8000/docs`.

## Configuration

Environment variables:

- `CAROUSEL_DATA_DIR`: private upload/job storage (default: an OS temp directory);
- `CAROUSEL_MAX_UPLOAD_BYTES`: compressed upload limit;
- `CAROUSEL_MAX_MASTER_ROWS`: explicit master-import row limit (20,000,000 by default);
- `CAROUSEL_MAX_ARCHIVE_MEMBERS`: maximum ZIP members;
- `CAROUSEL_MAX_UNCOMPRESSED_BYTES`: total uncompressed ZIP limit;
- `CAROUSEL_MAX_COMPRESSION_RATIO`: per-member and aggregate ZIP ratio limit;
- `CAROUSEL_JOB_WORKERS`: bounded worker-pool size;
- `CAROUSEL_OBJECT_TTL_SECONDS`: upload/result lifetime;
- `CAROUSEL_CLEANUP_INTERVAL_SECONDS`: TTL cleanup interval;
- `CAROUSEL_PREVIEW_LIMIT`: maximum rows read per sheet during inspection.

Run one API process when using the local SQLite registry and job workspaces.
For horizontal scaling, replace `JobService` and local storage with a shared
queue/object store as described in `docs/architecture.md`.

## Tests

```bash
.venv/bin/pytest -q backend/tests
```

The upload is stored under a random server-side name and made read-only after
validation. Results and reports are newly created files; originals are never
modified.
