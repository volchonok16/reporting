-- АОН: 11 символов → маркер 4:4; 1..4 → 4:2; 5..10 и >11 — недопустимо.
-- Выгрузка: при ведущем «*» заменить на «b»; без «*» ничего не подставлять.

CREATE OR REPLACE FUNCTION master_aon_significant_length(value TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN value IS NULL OR btrim(value) = '' THEN 0
        ELSE length(
            CASE
                WHEN left(ltrim(value, '+'), 1) IN ('b', 'B')
                    THEN CASE
                        WHEN substr(ltrim(value, '+'), 2, 1) = '*'
                            THEN substr(ltrim(value, '+'), 3)
                        ELSE substr(ltrim(value, '+'), 2)
                    END
                WHEN left(ltrim(value, '+'), 1) = '*'
                    THEN substr(ltrim(value, '+'), 2)
                ELSE ltrim(value, '+')
            END
        )
    END
$$;

CREATE OR REPLACE FUNCTION master_is_short_aon(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT value IS NOT NULL
       AND master_aon_significant_length(value) BETWEEN 1 AND 4
       AND ltrim(value, '+') ~ '^(b|B)?\*?[0-9*]{1,4}$'
$$;

CREATE OR REPLACE FUNCTION master_format_b_for_output(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN value IS NULL THEN NULL
        WHEN master_is_short_aon(value)
             AND ltrim(value, '+') ~ '^(b|B)?\*'
            THEN 'b' || regexp_replace(ltrim(value, '+'), '^(b|B)?\*', '')
        WHEN master_is_short_aon(value)
            THEN regexp_replace(ltrim(value, '+'), '^(b|B)', '')
        ELSE ltrim(value, '+')
    END
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
    IF master_is_short_aon(first_b) THEN
        first_marker := '4:2';
    ELSIF master_aon_significant_length(first_b) = 11 THEN
        first_marker := '4:4';
    END IF;
    out_first := COALESCE(master_format_b_for_output(first_b), a_number);
    rest := '';
    idx := 0;
    FOR elem IN SELECT jsonb_array_elements_text(arr)
    LOOP
        IF idx = 0 THEN
            NULL;
        ELSE
            out_elem := COALESCE(master_format_b_for_output(elem), elem);
            rest := rest || ';4,1,' || out_elem;
        END IF;
        idx := idx + 1;
    END LOOP;
    RETURN prefix || a_number || '=' || first_marker || ',1,' || out_first || rest;
END;
$$;

COMMENT ON FUNCTION master_is_short_aon(TEXT) IS
    'Короткий АОН: значимая длина 1..4 (после опциональных b/*)';
COMMENT ON FUNCTION master_format_b_for_output(TEXT) IS
    'Выгрузка B: *661→b661; без * — как есть; 11 цифр без изменений';
