-- Короткие АОН (< 8 символов, цифра или '*'): маркер 4:2 и префикс b в logical_row.

CREATE OR REPLACE FUNCTION master_is_short_aon(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT value IS NOT NULL
       AND length(value) BETWEEN 1 AND 7
       AND value ~ '^(\*|[0-9])[0-9*]*$'
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
