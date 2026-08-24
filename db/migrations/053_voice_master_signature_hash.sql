-- Voice master: hash PK / indexes so large b_numbers_json does not hit
-- PostgreSQL btree limit (~2704 bytes) during import compare / exact-counts.

CREATE OR REPLACE FUNCTION master_exact_signature(
    a_number TEXT,
    b_numbers_json TEXT,
    source_prefix TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT md5(
        COALESCE(a_number, '')
        || E'\x1f'
        || COALESCE(b_numbers_json, '')
        || E'\x1f'
        || COALESCE(source_prefix, '')
    );
$$;

CREATE OR REPLACE FUNCTION master_b_signature(
    b_numbers_json TEXT,
    source_prefix TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT md5(
        COALESCE(b_numbers_json, '')
        || E'\x1f'
        || COALESCE(source_prefix, '')
    );
$$;

-- master_exact_counts: PK on hash, not on full JSON
CREATE TABLE IF NOT EXISTS master_exact_counts_hash (
    signature_hash   TEXT PRIMARY KEY,
    a_number         TEXT NOT NULL,
    b_numbers_json   TEXT NOT NULL,
    source_prefix    TEXT NOT NULL,
    active_count     INTEGER NOT NULL
);

INSERT INTO master_exact_counts_hash (
    signature_hash, a_number, b_numbers_json, source_prefix, active_count
)
SELECT
    master_exact_signature(a_number, b_numbers_json, source_prefix),
    a_number,
    b_numbers_json,
    source_prefix,
    active_count
FROM master_exact_counts
ON CONFLICT (signature_hash) DO NOTHING;

DROP TABLE IF EXISTS master_exact_counts;
ALTER TABLE master_exact_counts_hash RENAME TO master_exact_counts;

CREATE INDEX IF NOT EXISTS master_exact_counts_lookup
    ON master_exact_counts (a_number, source_prefix);

DROP INDEX IF EXISTS master_records_signature;
CREATE INDEX IF NOT EXISTS master_records_signature
    ON master_records (deleted_at, master_b_signature(b_numbers_json, source_prefix));

-- Triggers: ON CONFLICT on signature_hash
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

CREATE OR REPLACE FUNCTION master_records_exact_count_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.deleted_at IS NULL THEN
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
