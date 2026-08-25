-- Voice master: TEXT id → BIGINT (IDENTITY) для records/imports/items/changes
-- и связанных import_id / item_id / record_id / existing_record_id.
-- Идемпотентно: если id уже BIGINT — пропускает конвертацию.
-- ./scripts/migrate.sh db/migrations/056_voice_master_numeric_ids.sql

DO $$
DECLARE
    r RECORD;
    records_id_type TEXT;
    warnings_import_type TEXT;
    findings_import_type TEXT;
    items_id_type TEXT;
    items_import_type TEXT;
    changes_id_type TEXT;
    changes_record_type TEXT;
BEGIN
    SELECT data_type INTO records_id_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_records'
      AND column_name = 'id';

    IF records_id_type IS NULL THEN
        RAISE EXCEPTION 'master_records.id not found';
    END IF;

    -- Починка полуприменённой 056: parent уже bigint, children ещё text.
    IF records_id_type = 'bigint' THEN
        SELECT data_type INTO warnings_import_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_import_number_warnings'
          AND column_name = 'import_id';
        SELECT data_type INTO findings_import_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_duplicate_findings'
          AND column_name = 'import_id';
        SELECT data_type INTO items_id_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_import_items'
          AND column_name = 'id';
        SELECT data_type INTO items_import_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_import_items'
          AND column_name = 'import_id';
        SELECT data_type INTO changes_id_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_changes'
          AND column_name = 'id';
        SELECT data_type INTO changes_record_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_changes'
          AND column_name = 'record_id';

        IF warnings_import_type IS DISTINCT FROM 'bigint'
           OR findings_import_type IS DISTINCT FROM 'bigint'
           OR items_id_type IS DISTINCT FROM 'bigint'
           OR items_import_type IS DISTINCT FROM 'bigint' THEN
            RAISE NOTICE '056: repair half-migrated import tables';
            TRUNCATE TABLE master_import_number_warnings;
            TRUNCATE TABLE master_duplicate_findings;
            DELETE FROM master_import_items;
            DELETE FROM master_imports;

            -- warnings
            ALTER TABLE master_import_number_warnings
                DROP CONSTRAINT IF EXISTS master_import_number_warnings_import_id_fkey;
            DROP INDEX IF EXISTS master_import_warnings_order;
            DROP INDEX IF EXISTS master_import_warnings_item;
            ALTER TABLE master_import_number_warnings DROP COLUMN IF EXISTS import_id;
            ALTER TABLE master_import_number_warnings DROP COLUMN IF EXISTS item_id;
            ALTER TABLE master_import_number_warnings DROP COLUMN IF EXISTS import_id_new;
            ALTER TABLE master_import_number_warnings DROP COLUMN IF EXISTS item_id_new;
            ALTER TABLE master_import_number_warnings
                ADD COLUMN import_id BIGINT NOT NULL;
            ALTER TABLE master_import_number_warnings
                ADD COLUMN item_id BIGINT NOT NULL;

            -- findings
            ALTER TABLE master_duplicate_findings
                DROP CONSTRAINT IF EXISTS master_duplicate_findings_import_id_fkey;
            ALTER TABLE master_duplicate_findings
                DROP CONSTRAINT IF EXISTS master_duplicate_findings_pkey;
            DROP INDEX IF EXISTS master_duplicate_findings_a;
            DROP INDEX IF EXISTS master_duplicate_findings_a_key;
            ALTER TABLE master_duplicate_findings DROP COLUMN IF EXISTS import_id;
            ALTER TABLE master_duplicate_findings DROP COLUMN IF EXISTS import_id_new;
            ALTER TABLE master_duplicate_findings
                ADD COLUMN import_id BIGINT NOT NULL;
            ALTER TABLE master_duplicate_findings
                ADD PRIMARY KEY (import_id, a_number);

            -- items
            ALTER TABLE master_import_items
                DROP CONSTRAINT IF EXISTS master_import_items_import_id_fkey;
            ALTER TABLE master_import_items
                DROP CONSTRAINT IF EXISTS master_import_items_pkey;
            DROP INDEX IF EXISTS master_import_items_status;
            DROP INDEX IF EXISTS master_import_items_a;
            DROP INDEX IF EXISTS master_import_items_a_key;
            ALTER TABLE master_import_items DROP COLUMN IF EXISTS id;
            ALTER TABLE master_import_items DROP COLUMN IF EXISTS import_id;
            ALTER TABLE master_import_items DROP COLUMN IF EXISTS existing_record_id;
            ALTER TABLE master_import_items DROP COLUMN IF EXISTS id_new;
            ALTER TABLE master_import_items DROP COLUMN IF EXISTS import_id_new;
            ALTER TABLE master_import_items DROP COLUMN IF EXISTS existing_record_id_new;
            ALTER TABLE master_import_items
                ADD COLUMN id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY;
            ALTER TABLE master_import_items
                ADD COLUMN import_id BIGINT NOT NULL;
            ALTER TABLE master_import_items
                ADD COLUMN existing_record_id BIGINT;

            -- imports id
            IF (
                SELECT data_type FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'master_imports'
                  AND column_name = 'id'
            ) IS DISTINCT FROM 'bigint' THEN
                ALTER TABLE master_imports DROP CONSTRAINT IF EXISTS master_imports_pkey;
                DROP INDEX IF EXISTS master_imports_owner;
                ALTER TABLE master_imports DROP COLUMN IF EXISTS id;
                ALTER TABLE master_imports DROP COLUMN IF EXISTS id_new;
                ALTER TABLE master_imports
                    ADD COLUMN id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY;
            END IF;
        END IF;

        IF changes_id_type IS DISTINCT FROM 'bigint'
           OR changes_record_type IS DISTINCT FROM 'bigint' THEN
            RAISE NOTICE '056: repair half-migrated master_changes';
            TRUNCATE TABLE master_changes;
            ALTER TABLE master_changes DROP CONSTRAINT IF EXISTS master_changes_pkey;
            DROP INDEX IF EXISTS master_changes_record;
            ALTER TABLE master_changes DROP COLUMN IF EXISTS id;
            ALTER TABLE master_changes DROP COLUMN IF EXISTS record_id;
            ALTER TABLE master_changes DROP COLUMN IF EXISTS id_new;
            ALTER TABLE master_changes DROP COLUMN IF EXISTS record_id_new;
            ALTER TABLE master_changes
                ADD COLUMN id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY;
            ALTER TABLE master_changes
                ADD COLUMN record_id BIGINT NOT NULL DEFAULT 0;
        END IF;

        RAISE NOTICE '056: master_records.id already bigint — skip remap';
        RETURN;
    END IF;

    FOR r IN
        SELECT c.conname, c.conrelid::regclass AS tbl
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = 'master_imports'::regclass
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
END $$;

DO $$
DECLARE
    records_id_type TEXT;
BEGIN
    SELECT data_type INTO records_id_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_records'
      AND column_name = 'id';

    IF records_id_type = 'bigint' THEN
        RETURN;
    END IF;

    CREATE TABLE IF NOT EXISTS master_records_id_map (
        old_id TEXT PRIMARY KEY,
        new_id BIGINT NOT NULL UNIQUE
    );

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_records'
          AND column_name = 'id_new'
    ) THEN
        ALTER TABLE master_records
            ADD COLUMN id_new BIGINT GENERATED BY DEFAULT AS IDENTITY;
    END IF;

    INSERT INTO master_records_id_map (old_id, new_id)
    SELECT id::text, id_new
    FROM master_records
    WHERE id_new IS NOT NULL
    ON CONFLICT (old_id) DO NOTHING;

    ALTER TABLE master_records DROP CONSTRAINT IF EXISTS master_records_pkey;
    ALTER TABLE master_records DROP COLUMN IF EXISTS id;
    ALTER TABLE master_records RENAME COLUMN id_new TO id;
    ALTER TABLE master_records ADD PRIMARY KEY (id);

    IF pg_get_serial_sequence('master_records', 'id') IS NOT NULL THEN
        PERFORM setval(
            pg_get_serial_sequence('master_records', 'id'),
            COALESCE((SELECT MAX(id) FROM master_records), 1),
            EXISTS (SELECT 1 FROM master_records LIMIT 1)
        );
    END IF;
END $$;

DO $$
DECLARE
    imports_id_type TEXT;
BEGIN
    SELECT data_type INTO imports_id_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_imports'
      AND column_name = 'id';

    IF imports_id_type = 'bigint' THEN
        RETURN;
    END IF;

    CREATE TABLE IF NOT EXISTS master_imports_id_map (
        old_id TEXT PRIMARY KEY,
        new_id BIGINT NOT NULL UNIQUE
    );

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_imports'
          AND column_name = 'id_new'
    ) THEN
        ALTER TABLE master_imports
            ADD COLUMN id_new BIGINT GENERATED BY DEFAULT AS IDENTITY;
    END IF;

    INSERT INTO master_imports_id_map (old_id, new_id)
    SELECT id::text, id_new
    FROM master_imports
    WHERE id_new IS NOT NULL
    ON CONFLICT (old_id) DO NOTHING;

    ALTER TABLE master_imports DROP CONSTRAINT IF EXISTS master_imports_pkey;
    DROP INDEX IF EXISTS master_imports_owner;
    ALTER TABLE master_imports DROP COLUMN IF EXISTS id;
    ALTER TABLE master_imports RENAME COLUMN id_new TO id;
    ALTER TABLE master_imports ADD PRIMARY KEY (id);

    IF pg_get_serial_sequence('master_imports', 'id') IS NOT NULL THEN
        PERFORM setval(
            pg_get_serial_sequence('master_imports', 'id'),
            COALESCE((SELECT MAX(id) FROM master_imports), 1),
            EXISTS (SELECT 1 FROM master_imports LIMIT 1)
        );
    END IF;

    CREATE INDEX IF NOT EXISTS master_imports_owner
        ON master_imports (id, session_id);
END $$;

DO $$
DECLARE
    items_id_type TEXT;
BEGIN
    SELECT data_type INTO items_id_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_import_items'
      AND column_name = 'id';

    IF items_id_type = 'bigint' THEN
        RETURN;
    END IF;

    CREATE TABLE IF NOT EXISTS master_import_items_id_map (
        old_id TEXT PRIMARY KEY,
        new_id BIGINT NOT NULL UNIQUE
    );

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'master_import_items'
          AND column_name = 'id_new'
    ) THEN
        ALTER TABLE master_import_items
            ADD COLUMN id_new BIGINT GENERATED BY DEFAULT AS IDENTITY;
    END IF;

    ALTER TABLE master_import_items
        ADD COLUMN IF NOT EXISTS import_id_new BIGINT;
    ALTER TABLE master_import_items
        ADD COLUMN IF NOT EXISTS existing_record_id_new BIGINT;

    INSERT INTO master_import_items_id_map (old_id, new_id)
    SELECT id::text, id_new
    FROM master_import_items
    WHERE id_new IS NOT NULL
    ON CONFLICT (old_id) DO NOTHING;

    UPDATE master_import_items AS item
    SET import_id_new = map.new_id
    FROM master_imports_id_map AS map
    WHERE map.old_id = item.import_id::text
      AND item.import_id_new IS NULL;

    UPDATE master_import_items AS item
    SET existing_record_id_new = map.new_id
    FROM master_records_id_map AS map
    WHERE item.existing_record_id IS NOT NULL
      AND map.old_id = item.existing_record_id::text
      AND item.existing_record_id_new IS NULL;

    ALTER TABLE master_import_items DROP CONSTRAINT IF EXISTS master_import_items_pkey;
    DROP INDEX IF EXISTS master_import_items_status;
    DROP INDEX IF EXISTS master_import_items_a;
    DROP INDEX IF EXISTS master_import_items_a_key;

    ALTER TABLE master_import_items DROP COLUMN IF EXISTS id;
    ALTER TABLE master_import_items DROP COLUMN IF EXISTS import_id;
    ALTER TABLE master_import_items DROP COLUMN IF EXISTS existing_record_id;
    ALTER TABLE master_import_items RENAME COLUMN id_new TO id;
    ALTER TABLE master_import_items RENAME COLUMN import_id_new TO import_id;
    ALTER TABLE master_import_items RENAME COLUMN existing_record_id_new TO existing_record_id;

    ALTER TABLE master_import_items ALTER COLUMN import_id SET NOT NULL;
    ALTER TABLE master_import_items ADD PRIMARY KEY (id);

    IF pg_get_serial_sequence('master_import_items', 'id') IS NOT NULL THEN
        PERFORM setval(
            pg_get_serial_sequence('master_import_items', 'id'),
            COALESCE((SELECT MAX(id) FROM master_import_items), 1),
            EXISTS (SELECT 1 FROM master_import_items LIMIT 1)
        );
    END IF;
END $$;

-- warnings / findings / changes + FK/indexes (безопасно повторять)
DO $$
DECLARE
    warning_import_type TEXT;
BEGIN
    SELECT data_type INTO warning_import_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_import_number_warnings'
      AND column_name = 'import_id';

    IF warning_import_type IS DISTINCT FROM 'bigint' THEN
        ALTER TABLE master_import_number_warnings
            ADD COLUMN IF NOT EXISTS import_id_new BIGINT;
        ALTER TABLE master_import_number_warnings
            ADD COLUMN IF NOT EXISTS item_id_new BIGINT;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'master_imports_id_map') THEN
            UPDATE master_import_number_warnings AS warning
            SET import_id_new = map.new_id
            FROM master_imports_id_map AS map
            WHERE map.old_id = warning.import_id::text
              AND warning.import_id_new IS NULL;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'master_import_items_id_map') THEN
            UPDATE master_import_number_warnings AS warning
            SET item_id_new = map.new_id
            FROM master_import_items_id_map AS map
            WHERE map.old_id = warning.item_id::text
              AND warning.item_id_new IS NULL;
        END IF;

        DROP INDEX IF EXISTS master_import_warnings_order;
        DROP INDEX IF EXISTS master_import_warnings_item;

        ALTER TABLE master_import_number_warnings DROP COLUMN IF EXISTS import_id;
        ALTER TABLE master_import_number_warnings DROP COLUMN IF EXISTS item_id;
        ALTER TABLE master_import_number_warnings RENAME COLUMN import_id_new TO import_id;
        ALTER TABLE master_import_number_warnings RENAME COLUMN item_id_new TO item_id;

        ALTER TABLE master_import_number_warnings ALTER COLUMN import_id SET NOT NULL;
        ALTER TABLE master_import_number_warnings ALTER COLUMN item_id SET NOT NULL;
    END IF;
END $$;

DO $$
DECLARE
    finding_import_type TEXT;
BEGIN
    SELECT data_type INTO finding_import_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_duplicate_findings'
      AND column_name = 'import_id';

    IF finding_import_type IS DISTINCT FROM 'bigint' THEN
        ALTER TABLE master_duplicate_findings
            ADD COLUMN IF NOT EXISTS import_id_new BIGINT;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'master_imports_id_map') THEN
            UPDATE master_duplicate_findings AS finding
            SET import_id_new = map.new_id
            FROM master_imports_id_map AS map
            WHERE map.old_id = finding.import_id::text
              AND finding.import_id_new IS NULL;
        END IF;

        ALTER TABLE master_duplicate_findings
            DROP CONSTRAINT IF EXISTS master_duplicate_findings_pkey;
        DROP INDEX IF EXISTS master_duplicate_findings_a;
        DROP INDEX IF EXISTS master_duplicate_findings_a_key;

        ALTER TABLE master_duplicate_findings DROP COLUMN IF EXISTS import_id;
        ALTER TABLE master_duplicate_findings RENAME COLUMN import_id_new TO import_id;
        ALTER TABLE master_duplicate_findings ALTER COLUMN import_id SET NOT NULL;
        ALTER TABLE master_duplicate_findings
            ADD PRIMARY KEY (import_id, a_number);
    END IF;
END $$;

DO $$
DECLARE
    changes_id_type TEXT;
BEGIN
    SELECT data_type INTO changes_id_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_changes'
      AND column_name = 'id';

    IF changes_id_type IS DISTINCT FROM 'bigint' THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'master_changes'
              AND column_name = 'id_new'
        ) THEN
            ALTER TABLE master_changes
                ADD COLUMN id_new BIGINT GENERATED BY DEFAULT AS IDENTITY;
        END IF;
        ALTER TABLE master_changes
            ADD COLUMN IF NOT EXISTS record_id_new BIGINT;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'master_records_id_map') THEN
            UPDATE master_changes AS change_row
            SET record_id_new = map.new_id
            FROM master_records_id_map AS map
            WHERE map.old_id = change_row.record_id::text
              AND change_row.record_id_new IS NULL;
        END IF;

        UPDATE master_changes
        SET record_id_new = 0
        WHERE record_id_new IS NULL;

        ALTER TABLE master_changes DROP CONSTRAINT IF EXISTS master_changes_pkey;
        DROP INDEX IF EXISTS master_changes_record;

        ALTER TABLE master_changes DROP COLUMN IF EXISTS id;
        ALTER TABLE master_changes DROP COLUMN IF EXISTS record_id;
        ALTER TABLE master_changes RENAME COLUMN id_new TO id;
        ALTER TABLE master_changes RENAME COLUMN record_id_new TO record_id;

        ALTER TABLE master_changes ALTER COLUMN record_id SET NOT NULL;
        ALTER TABLE master_changes ADD PRIMARY KEY (id);

        IF pg_get_serial_sequence('master_changes', 'id') IS NOT NULL THEN
            PERFORM setval(
                pg_get_serial_sequence('master_changes', 'id'),
                COALESCE((SELECT MAX(id) FROM master_changes), 1),
                EXISTS (SELECT 1 FROM master_changes LIMIT 1)
            );
        END IF;

        CREATE INDEX IF NOT EXISTS master_changes_record
            ON master_changes (record_id, revision DESC);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'master_import_items_import_id_fkey'
    ) THEN
        ALTER TABLE master_import_items
            ADD CONSTRAINT master_import_items_import_id_fkey
            FOREIGN KEY (import_id) REFERENCES master_imports(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'master_import_number_warnings_import_id_fkey'
    ) THEN
        ALTER TABLE master_import_number_warnings
            ADD CONSTRAINT master_import_number_warnings_import_id_fkey
            FOREIGN KEY (import_id) REFERENCES master_imports(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'master_duplicate_findings_import_id_fkey'
    ) THEN
        ALTER TABLE master_duplicate_findings
            ADD CONSTRAINT master_duplicate_findings_import_id_fkey
            FOREIGN KEY (import_id) REFERENCES master_imports(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS master_import_items_status
    ON master_import_items (import_id, status, source_row);
CREATE INDEX IF NOT EXISTS master_import_items_a
    ON master_import_items (import_id, a_number);
CREATE INDEX IF NOT EXISTS master_import_warnings_order
    ON master_import_number_warnings (import_id, source_row);
CREATE INDEX IF NOT EXISTS master_import_warnings_item
    ON master_import_number_warnings (import_id, item_id);
CREATE INDEX IF NOT EXISTS master_duplicate_findings_a
    ON master_duplicate_findings (a_number, import_id);
CREATE INDEX IF NOT EXISTS master_imports_owner
    ON master_imports (id, session_id);
CREATE INDEX IF NOT EXISTS master_changes_record
    ON master_changes (record_id, revision DESC);

DROP TABLE IF EXISTS master_records_id_map;
DROP TABLE IF EXISTS master_imports_id_map;
DROP TABLE IF EXISTS master_import_items_id_map;

COMMENT ON COLUMN master_records.id IS
    'Числовой PK (BIGINT IDENTITY)';
COMMENT ON COLUMN master_imports.id IS
    'Числовой PK (BIGINT IDENTITY)';
COMMENT ON COLUMN master_import_items.id IS
    'Числовой PK (BIGINT IDENTITY)';
COMMENT ON COLUMN master_changes.id IS
    'Числовой PK (BIGINT IDENTITY)';
