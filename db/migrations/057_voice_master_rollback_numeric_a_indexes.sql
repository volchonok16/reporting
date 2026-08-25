-- Откат 055: убрать a_number_key / master_number_key, вернуть btree по TEXT a_number.
-- ./scripts/migrate.sh db/migrations/057_voice_master_rollback_numeric_a_indexes.sql

DROP INDEX IF EXISTS master_records_a_key;
DROP INDEX IF EXISTS master_a_counts_key;
DROP INDEX IF EXISTS master_exact_counts_lookup;
DROP INDEX IF EXISTS master_import_items_a_key;
DROP INDEX IF EXISTS master_duplicate_findings_a_key;

ALTER TABLE master_records DROP COLUMN IF EXISTS a_number_key;
ALTER TABLE master_a_counts DROP COLUMN IF EXISTS a_number_key;
ALTER TABLE master_exact_counts DROP COLUMN IF EXISTS a_number_key;
ALTER TABLE master_import_items DROP COLUMN IF EXISTS a_number_key;
ALTER TABLE master_duplicate_findings DROP COLUMN IF EXISTS a_number_key;

DROP FUNCTION IF EXISTS master_number_key(TEXT);

CREATE INDEX IF NOT EXISTS master_records_a
    ON master_records (a_number, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS master_a_counts_a
    ON master_a_counts (a_number);
CREATE INDEX IF NOT EXISTS master_exact_counts_lookup
    ON master_exact_counts (a_number, source_prefix);
CREATE INDEX IF NOT EXISTS master_import_items_a
    ON master_import_items (import_id, a_number);
CREATE INDEX IF NOT EXISTS master_duplicate_findings_a
    ON master_duplicate_findings (a_number, import_id);

-- Триггеры exact-count как в 053 (без a_number_key)
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
              AND matching_record.a_number = NEW.a_number
              AND matching_record.b_numbers_json = NEW.b_numbers_json
              AND matching_record.source_prefix = NEW.source_prefix
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
              AND matching_record.a_number = NEW.a_number
              AND matching_record.b_numbers_json = NEW.b_numbers_json
              AND matching_record.source_prefix = NEW.source_prefix
        )
        ON CONFLICT (signature_hash)
        DO UPDATE SET active_count = master_exact_counts.active_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
