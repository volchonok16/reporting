-- Мастер-файл Voice в PostgreSQL reporting (вместо SQLite registry)
-- ./scripts/migrate.sh db/migrations/050_voice_master.sql

CREATE TABLE IF NOT EXISTS master_state (
    id                SMALLINT PRIMARY KEY CHECK (id = 1),
    current_revision  INTEGER NOT NULL
);

INSERT INTO master_state (id, current_revision)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS master_schema_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS master_records (
    id                 TEXT PRIMARY KEY,
    a_number           TEXT NOT NULL,
    b_numbers_json     TEXT NOT NULL,
    source_prefix      TEXT NOT NULL,
    comment            TEXT NOT NULL DEFAULT '',
    sort_order         INTEGER NOT NULL,
    version            INTEGER NOT NULL,
    created_at         DOUBLE PRECISION NOT NULL,
    updated_at         DOUBLE PRECISION NOT NULL,
    created_revision   INTEGER NOT NULL,
    updated_revision   INTEGER NOT NULL,
    deleted_at         DOUBLE PRECISION,
    deleted_revision   INTEGER
);

CREATE INDEX IF NOT EXISTS master_records_active_order
    ON master_records (deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS master_records_updated
    ON master_records (updated_at DESC);
CREATE INDEX IF NOT EXISTS master_records_a
    ON master_records (a_number, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS master_records_signature
    ON master_records (deleted_at, b_numbers_json, source_prefix);

CREATE TABLE IF NOT EXISTS master_a_counts (
    a_number      TEXT PRIMARY KEY,
    active_count  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS master_exact_counts (
    a_number         TEXT NOT NULL,
    b_numbers_json   TEXT NOT NULL,
    source_prefix    TEXT NOT NULL,
    active_count     INTEGER NOT NULL,
    PRIMARY KEY (a_number, b_numbers_json, source_prefix)
);

CREATE TABLE IF NOT EXISTS master_changes (
    id               TEXT PRIMARY KEY,
    revision         INTEGER NOT NULL,
    sequence         INTEGER NOT NULL,
    record_id        TEXT NOT NULL,
    action           TEXT NOT NULL,
    line_number      INTEGER,
    before_json      TEXT,
    after_json       TEXT,
    source_file      TEXT,
    source_row       INTEGER,
    actor            TEXT NOT NULL,
    created_at       DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS master_changes_revision
    ON master_changes (revision DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS master_changes_record
    ON master_changes (record_id, revision DESC);
CREATE INDEX IF NOT EXISTS master_changes_created_at
    ON master_changes (created_at DESC);

CREATE TABLE IF NOT EXISTS master_imports (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    upload_id         TEXT NOT NULL,
    source_name       TEXT NOT NULL,
    detected_mode     TEXT NOT NULL,
    base_revision     INTEGER NOT NULL,
    status            TEXT NOT NULL,
    stats_json        TEXT NOT NULL,
    request_json      TEXT NOT NULL DEFAULT '{}',
    warnings_json     TEXT NOT NULL DEFAULT '{}',
    progress_rows     INTEGER NOT NULL DEFAULT 0,
    progress_phase    TEXT NOT NULL DEFAULT 'queued',
    error_code        TEXT,
    error_message     TEXT,
    updated_at        DOUBLE PRECISION,
    created_at        DOUBLE PRECISION NOT NULL,
    merged_at         DOUBLE PRECISION,
    merged_revision   INTEGER
);

CREATE INDEX IF NOT EXISTS master_imports_owner
    ON master_imports (id, session_id);
CREATE INDEX IF NOT EXISTS master_imports_active_owner
    ON master_imports (session_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS master_duplicate_findings (
    import_id         TEXT NOT NULL REFERENCES master_imports(id) ON DELETE CASCADE,
    a_number          TEXT NOT NULL,
    source_rows_json  TEXT NOT NULL,
    source_file       TEXT NOT NULL,
    created_at        DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (import_id, a_number)
);

CREATE INDEX IF NOT EXISTS master_duplicate_findings_a
    ON master_duplicate_findings (a_number, import_id);

CREATE TABLE IF NOT EXISTS master_import_items (
    id                  TEXT PRIMARY KEY,
    import_id           TEXT NOT NULL REFERENCES master_imports(id) ON DELETE CASCADE,
    source_row          INTEGER NOT NULL,
    a_number            TEXT NOT NULL,
    incoming_json       TEXT NOT NULL,
    incoming_b_json     TEXT NOT NULL DEFAULT '[]',
    incoming_prefix     TEXT NOT NULL DEFAULT '',
    existing_record_id  TEXT,
    current_json        TEXT,
    status              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS master_import_items_status
    ON master_import_items (import_id, status, source_row);
CREATE INDEX IF NOT EXISTS master_import_items_a
    ON master_import_items (import_id, a_number);

CREATE TABLE IF NOT EXISTS master_import_number_warnings (
    import_id    TEXT NOT NULL REFERENCES master_imports(id) ON DELETE CASCADE,
    item_id      TEXT NOT NULL,
    source_row   INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    number       TEXT NOT NULL,
    a_number     TEXT NOT NULL,
    status       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS master_import_warnings_order
    ON master_import_number_warnings (import_id, source_row);
CREATE INDEX IF NOT EXISTS master_import_warnings_item
    ON master_import_number_warnings (import_id, item_id);

-- Блокировка редактирования (без FK на SQLite auth_* — user/session id как текст)
CREATE TABLE IF NOT EXISTS master_edit_lock (
    id                            SMALLINT PRIMARY KEY CHECK (id = 1),
    owner_user_id                 TEXT NOT NULL,
    owner_session_hash            TEXT NOT NULL,
    owner_email                   TEXT NOT NULL,
    acquired_at                   DOUBLE PRECISION NOT NULL,
    notification_sequence         INTEGER NOT NULL DEFAULT 0,
    notification_kind             TEXT,
    notification_requester_id     TEXT,
    notification_requester_email  TEXT,
    notification_created_at       DOUBLE PRECISION
);

ALTER TABLE master_edit_lock
    ADD COLUMN IF NOT EXISTS owner_email TEXT NOT NULL DEFAULT '';

-- Хелперы совместимости с SQL мастер-сервиса (SQLite json_*/GLOB)
CREATE OR REPLACE FUNCTION master_json_extract_text(data TEXT, path TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN path = '$[0]' THEN (data::jsonb ->> 0)
        WHEN path ~ '^\$\.([A-Za-z0-9_]+)$' THEN (data::jsonb ->> substring(path from 3))
        ELSE NULL
    END
$$;

CREATE OR REPLACE FUNCTION master_json_array_length(data TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(jsonb_array_length(data::jsonb), 0)
$$;

CREATE OR REPLACE FUNCTION master_is_digits(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT value ~ '^[0-9]+$'
$$;

-- SQLite GLOB → regex (для параметризованных GLOB ? в MasterService)
CREATE OR REPLACE FUNCTION master_glob_to_regex(pattern TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    result TEXT := '';
    i INT := 1;
    ch TEXT;
    n INT := length(pattern);
BEGIN
    WHILE i <= n LOOP
        ch := substr(pattern, i, 1);
        IF ch = '*' THEN
            result := result || '.*';
        ELSIF ch = '?' THEN
            result := result || '.';
        ELSIF ch = '[' THEN
            result := result || '[';
            i := i + 1;
            WHILE i <= n LOOP
                ch := substr(pattern, i, 1);
                result := result || ch;
                IF ch = ']' THEN
                    EXIT;
                END IF;
                i := i + 1;
            END LOOP;
        ELSE
            IF ch ~ '[.\\^$|()+{}]' THEN
                result := result || '\' || ch;
            ELSE
                result := result || ch;
            END IF;
        END IF;
        i := i + 1;
    END LOOP;
    RETURN '^' || result || '$';
END;
$$;

CREATE OR REPLACE FUNCTION master_glob_match(value TEXT, pattern TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(value, '') ~ master_glob_to_regex(COALESCE(pattern, ''))
$$;

CREATE OR REPLACE FUNCTION master_logical_row(
    a_number TEXT,
    b_numbers_json TEXT,
    source_prefix TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    prefix TEXT := COALESCE(source_prefix, '');
    first_b TEXT;
    rest TEXT := '';
    elem TEXT;
    idx INT := 0;
    arr JSONB;
    first_marker TEXT := '4:4';
BEGIN
    arr := COALESCE(b_numbers_json::jsonb, '[]'::jsonb);
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) = 0 THEN
        RETURN prefix || a_number || '=';
    END IF;
    first_b := arr ->> 0;
    IF jsonb_array_length(arr) = 1
       AND first_b ~ '^[0-9]+$'
       AND length(first_b) BETWEEN 3 AND 5 THEN
        first_marker := '4:2';
    END IF;
    rest := '';
    idx := 0;
    FOR elem IN SELECT jsonb_array_elements_text(arr)
    LOOP
        IF idx = 0 THEN
            NULL;
        ELSE
            rest := rest || ';4,1,' || elem;
        END IF;
        idx := idx + 1;
    END LOOP;
    RETURN prefix || a_number || '=' || first_marker || ',1,' || COALESCE(first_b, a_number) || rest;
END;
$$;

COMMENT ON TABLE master_records IS 'Мастер-файл Voice (карусель): записи A/B';
COMMENT ON TABLE master_edit_lock IS 'Эксклюзивная блокировка редактирования мастер-файла';
COMMENT ON COLUMN master_records.comment IS 'Комментарий, до 50000 символов (проверка в API)';

-- Совместимость имён с SQLite json_* в запросах MasterService
CREATE OR REPLACE FUNCTION json_extract(data TEXT, path TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT master_json_extract_text(data, path)
$$;

CREATE OR REPLACE FUNCTION json_array_length(data TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT master_json_array_length(data)
$$;

-- Триггеры счётчиков (аналог SQLite)
CREATE OR REPLACE FUNCTION master_records_count_insert_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NULL THEN
        INSERT INTO master_a_counts(a_number, active_count)
        VALUES (NEW.a_number, 1)
        ON CONFLICT (a_number) DO UPDATE
        SET active_count = master_a_counts.active_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION master_records_count_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.deleted_at IS NULL THEN
        UPDATE master_a_counts
        SET active_count = active_count - 1
        WHERE a_number = OLD.a_number;
        DELETE FROM master_a_counts
        WHERE a_number = OLD.a_number AND active_count <= 0;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION master_records_count_update_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.deleted_at IS NULL
       AND (NEW.deleted_at IS NOT NULL OR OLD.a_number IS DISTINCT FROM NEW.a_number) THEN
        UPDATE master_a_counts
        SET active_count = active_count - 1
        WHERE a_number = OLD.a_number;
        DELETE FROM master_a_counts
        WHERE a_number = OLD.a_number AND active_count <= 0;
    END IF;
    IF NEW.deleted_at IS NULL
       AND (OLD.deleted_at IS NOT NULL OR OLD.a_number IS DISTINCT FROM NEW.a_number) THEN
        INSERT INTO master_a_counts(a_number, active_count)
        VALUES (NEW.a_number, 1)
        ON CONFLICT (a_number) DO UPDATE
        SET active_count = master_a_counts.active_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION master_records_exact_count_insert_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NULL THEN
        INSERT INTO master_exact_counts(
            a_number, b_numbers_json, source_prefix, active_count
        )
        SELECT NEW.a_number, NEW.b_numbers_json, NEW.source_prefix, 2
        WHERE EXISTS (
            SELECT 1
            FROM master_records AS matching_record
            WHERE matching_record.deleted_at IS NULL
              AND matching_record.id <> NEW.id
              AND matching_record.a_number = NEW.a_number
              AND matching_record.b_numbers_json = NEW.b_numbers_json
              AND matching_record.source_prefix = NEW.source_prefix
        )
        ON CONFLICT (a_number, b_numbers_json, source_prefix)
        DO UPDATE SET active_count = master_exact_counts.active_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION master_records_exact_count_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.deleted_at IS NULL THEN
        UPDATE master_exact_counts
        SET active_count = active_count - 1
        WHERE a_number = OLD.a_number
          AND b_numbers_json = OLD.b_numbers_json
          AND source_prefix = OLD.source_prefix;
        DELETE FROM master_exact_counts
        WHERE a_number = OLD.a_number
          AND b_numbers_json = OLD.b_numbers_json
          AND source_prefix = OLD.source_prefix
          AND active_count <= 1;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION master_records_exact_count_update_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.deleted_at IS NULL
       AND (
            NEW.deleted_at IS NOT NULL
            OR OLD.a_number IS DISTINCT FROM NEW.a_number
            OR OLD.b_numbers_json IS DISTINCT FROM NEW.b_numbers_json
            OR OLD.source_prefix IS DISTINCT FROM NEW.source_prefix
       ) THEN
        UPDATE master_exact_counts
        SET active_count = active_count - 1
        WHERE a_number = OLD.a_number
          AND b_numbers_json = OLD.b_numbers_json
          AND source_prefix = OLD.source_prefix;
        DELETE FROM master_exact_counts
        WHERE a_number = OLD.a_number
          AND b_numbers_json = OLD.b_numbers_json
          AND source_prefix = OLD.source_prefix
          AND active_count <= 1;
    END IF;
    IF NEW.deleted_at IS NULL
       AND (
            OLD.deleted_at IS NOT NULL
            OR OLD.a_number IS DISTINCT FROM NEW.a_number
            OR OLD.b_numbers_json IS DISTINCT FROM NEW.b_numbers_json
            OR OLD.source_prefix IS DISTINCT FROM NEW.source_prefix
       ) THEN
        INSERT INTO master_exact_counts(
            a_number, b_numbers_json, source_prefix, active_count
        )
        SELECT NEW.a_number, NEW.b_numbers_json, NEW.source_prefix, 2
        WHERE EXISTS (
            SELECT 1
            FROM master_records AS matching_record
            WHERE matching_record.deleted_at IS NULL
              AND matching_record.id <> NEW.id
              AND matching_record.a_number = NEW.a_number
              AND matching_record.b_numbers_json = NEW.b_numbers_json
              AND matching_record.source_prefix = NEW.source_prefix
        )
        ON CONFLICT (a_number, b_numbers_json, source_prefix)
        DO UPDATE SET active_count = master_exact_counts.active_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS master_records_count_insert ON master_records;
DROP TRIGGER IF EXISTS master_records_count_delete ON master_records;
DROP TRIGGER IF EXISTS master_records_count_update ON master_records;
DROP TRIGGER IF EXISTS master_records_exact_count_insert ON master_records;
DROP TRIGGER IF EXISTS master_records_exact_count_delete ON master_records;
DROP TRIGGER IF EXISTS master_records_exact_count_update ON master_records;

CREATE TRIGGER master_records_count_insert
AFTER INSERT ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_count_insert_fn();

CREATE TRIGGER master_records_count_delete
AFTER DELETE ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_count_delete_fn();

CREATE TRIGGER master_records_count_update
AFTER UPDATE OF a_number, deleted_at ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_count_update_fn();

CREATE TRIGGER master_records_exact_count_insert
AFTER INSERT ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_exact_count_insert_fn();

CREATE TRIGGER master_records_exact_count_delete
AFTER DELETE ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_exact_count_delete_fn();

CREATE TRIGGER master_records_exact_count_update
AFTER UPDATE OF a_number, b_numbers_json, source_prefix, deleted_at ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_exact_count_update_fn();
