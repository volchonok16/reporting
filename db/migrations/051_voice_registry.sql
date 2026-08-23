-- Voice: uploads и jobs в PostgreSQL reporting (вместо SQLite registry.sqlite3)
-- Auth Voice — только через reporting SSO (без voice_auth_* таблиц).
-- ./scripts/migrate.sh db/migrations/051_voice_registry.sql

CREATE TABLE IF NOT EXISTS voice_uploads (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    size        BIGINT NOT NULL,
    format      TEXT NOT NULL,
    path        TEXT NOT NULL,
    created_at  DOUBLE PRECISION NOT NULL,
    expires_at  DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_uploads_owner
    ON voice_uploads (id, session_id);
CREATE INDEX IF NOT EXISTS voice_uploads_expires
    ON voice_uploads (expires_at);

CREATE TABLE IF NOT EXISTS voice_jobs (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    kind            TEXT NOT NULL,
    upload_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    stage           TEXT NOT NULL,
    progress        INTEGER NOT NULL,
    processed_rows  INTEGER NOT NULL,
    total_rows      INTEGER NOT NULL,
    error_json      TEXT,
    summary_json    TEXT,
    workspace       TEXT NOT NULL,
    result_path     TEXT NOT NULL,
    report_path     TEXT NOT NULL,
    created_at      DOUBLE PRECISION NOT NULL,
    updated_at      DOUBLE PRECISION NOT NULL,
    expires_at      DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_jobs_owner
    ON voice_jobs (id, session_id);
CREATE INDEX IF NOT EXISTS voice_jobs_upload
    ON voice_jobs (upload_id);
CREATE INDEX IF NOT EXISTS voice_jobs_expires
    ON voice_jobs (expires_at);

COMMENT ON TABLE voice_uploads IS 'Voice: метаданные загруженных файлов (тело — на диске CAROUSEL_DATA_DIR)';
COMMENT ON TABLE voice_jobs IS 'Voice: задания обработки загрузок';
