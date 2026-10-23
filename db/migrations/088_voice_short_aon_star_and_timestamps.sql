-- Voice: короткий АОН только с ведущим «*»;
-- created_at / updated_at / merged_at / deleted_at → timestamptz.
-- Триггеры UPDATE OF deleted_at мешают ALTER TYPE — снимаем и возвращаем.

CREATE OR REPLACE FUNCTION master_is_short_aon(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT value IS NOT NULL
       AND length(value) BETWEEN 1 AND 7
       AND value ~ '^\*[0-9*]*$'
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
    out_first TEXT;
    rest TEXT := '';
    elem TEXT;
    out_elem TEXT;
    idx INT := 0;
    arr JSONB;
    first_marker TEXT := '4:4';
BEGIN
    arr := COALESCE(b_numbers_json::jsonb, '[]'::jsonb);
    IF jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) = 0 THEN
        RETURN prefix || a_number || '=';
    END IF;
    first_b := arr ->> 0;
    IF jsonb_array_length(arr) = 1 AND master_is_short_aon(first_b) THEN
        first_marker := '4:2';
    END IF;
    out_first := CASE
        WHEN master_is_short_aon(first_b) THEN 'b' || first_b
        ELSE COALESCE(first_b, a_number)
    END;
    rest := '';
    idx := 0;
    FOR elem IN SELECT jsonb_array_elements_text(arr)
    LOOP
        IF idx = 0 THEN
            NULL;
        ELSE
            out_elem := CASE
                WHEN master_is_short_aon(elem) THEN 'b' || elem
                ELSE elem
            END;
            rest := rest || ';4,1,' || out_elem;
        END IF;
        idx := idx + 1;
    END LOOP;
    RETURN prefix || a_number || '=' || first_marker || ',1,' || out_first || rest;
END;
$$;

DROP TRIGGER IF EXISTS master_records_count_update ON master_records;
DROP TRIGGER IF EXISTS master_records_exact_count_update ON master_records;

-- master_records
ALTER TABLE master_records
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING to_timestamp(created_at),
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ
        USING to_timestamp(updated_at),
    ALTER COLUMN deleted_at TYPE TIMESTAMPTZ
        USING CASE
            WHEN deleted_at IS NULL THEN NULL
            ELSE to_timestamp(deleted_at)
        END;

CREATE TRIGGER master_records_count_update
AFTER UPDATE OF a_number, deleted_at ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_count_update_fn();

CREATE TRIGGER master_records_exact_count_update
AFTER UPDATE OF a_number, b_numbers_json, source_prefix, deleted_at ON master_records
FOR EACH ROW EXECUTE FUNCTION master_records_exact_count_update_fn();

-- master_changes
ALTER TABLE master_changes
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING to_timestamp(created_at);

-- master_imports
ALTER TABLE master_imports
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING to_timestamp(created_at),
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ
        USING CASE
            WHEN updated_at IS NULL THEN NULL
            ELSE to_timestamp(updated_at)
        END,
    ALTER COLUMN merged_at TYPE TIMESTAMPTZ
        USING CASE
            WHEN merged_at IS NULL THEN NULL
            ELSE to_timestamp(merged_at)
        END;

-- master_duplicate_findings
ALTER TABLE master_duplicate_findings
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING to_timestamp(created_at);

-- voice_uploads / voice_jobs
ALTER TABLE voice_uploads
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING to_timestamp(created_at);

ALTER TABLE voice_jobs
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING to_timestamp(created_at),
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ
        USING to_timestamp(updated_at);

COMMENT ON COLUMN master_records.created_at IS 'TIMESTAMPTZ (ранее Unix double)';
COMMENT ON COLUMN master_records.updated_at IS 'TIMESTAMPTZ (ранее Unix double)';
COMMENT ON COLUMN master_records.deleted_at IS 'TIMESTAMPTZ soft-delete (ранее Unix double)';
COMMENT ON COLUMN master_imports.merged_at IS 'TIMESTAMPTZ момента слияния (ранее Unix double)';
