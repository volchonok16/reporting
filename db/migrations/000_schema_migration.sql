-- Журнал применённых миграций (чтобы data-миграции не выполнялись повторно при каждом старте)

CREATE TABLE IF NOT EXISTS schema_migration (
    name         VARCHAR(255) PRIMARY KEY,
    applied_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE schema_migration IS 'Имена SQL-миграций, уже применённых ensure_startup_schema';
