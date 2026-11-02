-- Хранилище Симметрики (canvas-studio) в PostgreSQL вместо JSON-файлов на диске.
-- ./scripts/migrate.sh db/migrations/097_simmetrika_storage.sql

CREATE TABLE IF NOT EXISTS simmetrika_kv (
    bucket      TEXT         NOT NULL,
    id          TEXT         NOT NULL,
    payload     JSONB        NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bucket, id)
);

CREATE INDEX IF NOT EXISTS ix_simmetrika_kv_bucket
    ON simmetrika_kv (bucket);

COMMENT ON TABLE simmetrika_kv IS 'Симметрика: JSON-записи (users, sessions, files-meta, projects, teams, codes)';
COMMENT ON COLUMN simmetrika_kv.bucket IS 'Логическая «папка»: users | sessions | files-meta | projects | teams | codes';
COMMENT ON COLUMN simmetrika_kv.id IS 'Идентификатор записи внутри bucket';
COMMENT ON COLUMN simmetrika_kv.payload IS 'Тело записи (как бывший .json на диске)';

CREATE TABLE IF NOT EXISTS simmetrika_blob (
    file_id     TEXT         NOT NULL,
    name        TEXT         NOT NULL,
    content     BYTEA        NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (file_id, name)
);

CREATE INDEX IF NOT EXISTS ix_simmetrika_blob_file
    ON simmetrika_blob (file_id);

COMMENT ON TABLE simmetrika_blob IS 'Симметрика: содержимое файлов (snapshot, картинки, thumbnail, comments, versions)';
COMMENT ON COLUMN simmetrika_blob.file_id IS 'ID файла макета';
COMMENT ON COLUMN simmetrika_blob.name IS 'Имя объекта: snapshot.json, thumbnail, comments.json, i<sha>, v<hex>.gz, …';
COMMENT ON COLUMN simmetrika_blob.content IS 'Байты объекта';

CREATE TABLE IF NOT EXISTS simmetrika_secret (
    id          TEXT         PRIMARY KEY DEFAULT 'default',
    value       BYTEA        NOT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE simmetrika_secret IS 'Симметрика: серверный секрет (бывший файл data/secret)';
