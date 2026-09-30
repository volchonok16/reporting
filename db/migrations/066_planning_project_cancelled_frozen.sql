-- Статусы «Отменен» / «Заморожен» и даты для очистки ресурсов.

ALTER TABLE planning_project
    ADD COLUMN IF NOT EXISTS cancelled_at DATE,
    ADD COLUMN IF NOT EXISTS freeze_until_date DATE;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = 'planning_project'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) ILIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE planning_project DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE planning_project
    ADD CONSTRAINT planning_project_status_check
        CHECK (status IN ('new', 'in_progress', 'completed', 'cancelled', 'frozen'));

COMMENT ON COLUMN planning_project.status IS
    'Статус проекта: new, in_progress, completed, cancelled, frozen';
COMMENT ON COLUMN planning_project.cancelled_at IS
    'Дата отмены; при status=cancelled выделения с этой даты очищаются';
COMMENT ON COLUMN planning_project.freeze_until_date IS
    'Дата окончания заморозки; при status=frozen выделения до этой даты (включительно) очищаются';
