-- Voice master: числовые индексы по A (a_number_key BIGINT) вместо btree по TEXT.
-- ./scripts/migrate.sh db/migrations/055_voice_master_numeric_a_indexes.sql

CREATE OR REPLACE FUNCTION master_number_key(value TEXT)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN value IS NULL THEN NULL
        WHEN btrim(value) = '' THEN NULL
        WHEN regexp_replace(value, '[^0-9]', '', 'g') = '' THEN NULL
        WHEN length(regexp_replace(value, '[^0-9]', '', 'g')) > 18 THEN NULL
        ELSE regexp_replace(value, '[^0-9]', '', 'g')::BIGINT
    END;
$$;

COMMENT ON FUNCTION master_number_key(TEXT) IS
    'Цифровой ключ номера (только 0-9) для btree-индексов master_*';

ALTER TABLE master_records
    ADD COLUMN IF NOT EXISTS a_number_key BIGINT
    GENERATED ALWAYS AS (master_number_key(a_number)) STORED;

ALTER TABLE master_a_counts
    ADD COLUMN IF NOT EXISTS a_number_key BIGINT
    GENERATED ALWAYS AS (master_number_key(a_number)) STORED;

ALTER TABLE master_exact_counts
    ADD COLUMN IF NOT EXISTS a_number_key BIGINT
    GENERATED ALWAYS AS (master_number_key(a_number)) STORED;

ALTER TABLE master_import_items
    ADD COLUMN IF NOT EXISTS a_number_key BIGINT
    GENERATED ALWAYS AS (master_number_key(a_number)) STORED;

ALTER TABLE master_duplicate_findings
    ADD COLUMN IF NOT EXISTS a_number_key BIGINT
    GENERATED ALWAYS AS (master_number_key(a_number)) STORED;

DROP INDEX IF EXISTS master_records_a;
CREATE INDEX IF NOT EXISTS master_records_a_key
    ON master_records (a_number_key, deleted_at, sort_order);

CREATE INDEX IF NOT EXISTS master_a_counts_key
    ON master_a_counts (a_number_key);

DROP INDEX IF EXISTS master_exact_counts_lookup;
CREATE INDEX IF NOT EXISTS master_exact_counts_lookup
    ON master_exact_counts (a_number_key, source_prefix);

DROP INDEX IF EXISTS master_import_items_a;
CREATE INDEX IF NOT EXISTS master_import_items_a_key
    ON master_import_items (import_id, a_number_key);

DROP INDEX IF EXISTS master_duplicate_findings_a;
CREATE INDEX IF NOT EXISTS master_duplicate_findings_a_key
    ON master_duplicate_findings (a_number_key, import_id);

-- EXISTS в триггерах exact-count: сначала по числовому ключу, затем hash связки
CREATE OR REPLACE FUNCTION master_records_exact_count_insert_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.deleted_at IS NULL THEN
        INSERT INTO master_exact_counts(
            signature_hash, a_number, b_numbers_json, source_prefix, active_count
        )
        SELECT
            master_exact_signature(
                NEW.a_number, NEW.b_numbers_json, NEW.source_prefix
            ),
            NEW.a_number,
            NEW.b_numbers_json,
            NEW.source_prefix,
            2
        WHERE EXISTS (
            SELECT 1
            FROM master_records AS matching_record
            WHERE matching_record.deleted_at IS NULL
              AND matching_record.id <> NEW.id
              AND matching_record.a_number_key IS NOT DISTINCT FROM NEW.a_number_key
              AND matching_record.a_number = NEW.a_number
              AND matching_record.source_prefix = NEW.source_prefix
              AND master_b_signature(
                    matching_record.b_numbers_json, matching_record.source_prefix
                  ) = master_b_signature(NEW.b_numbers_json, NEW.source_prefix)
        )
        ON CONFLICT (signature_hash)
        DO UPDATE SET active_count = master_exact_counts.active_count + 1;
    END IF;
    RETURN NEW;
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
        WHERE signature_hash = master_exact_signature(
            OLD.a_number, OLD.b_numbers_json, OLD.source_prefix
        );
        DELETE FROM master_exact_counts
        WHERE signature_hash = master_exact_signature(
            OLD.a_number, OLD.b_numbers_json, OLD.source_prefix
        )
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
            signature_hash, a_number, b_numbers_json, source_prefix, active_count
        )
        SELECT
            master_exact_signature(
                NEW.a_number, NEW.b_numbers_json, NEW.source_prefix
            ),
            NEW.a_number,
            NEW.b_numbers_json,
            NEW.source_prefix,
            2
        WHERE EXISTS (
            SELECT 1
            FROM master_records AS matching_record
            WHERE matching_record.deleted_at IS NULL
              AND matching_record.id <> NEW.id
              AND matching_record.a_number_key IS NOT DISTINCT FROM NEW.a_number_key
              AND matching_record.a_number = NEW.a_number
              AND matching_record.source_prefix = NEW.source_prefix
              AND master_b_signature(
                    matching_record.b_numbers_json, matching_record.source_prefix
                  ) = master_b_signature(NEW.b_numbers_json, NEW.source_prefix)
        )
        ON CONFLICT (signature_hash)
        DO UPDATE SET active_count = master_exact_counts.active_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
