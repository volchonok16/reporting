-- Ускорение фильтров master по source_prefix (parameterGroup / region).
-- ./scripts/migrate.sh db/migrations/058_voice_master_prefix_index.sql

CREATE INDEX IF NOT EXISTS master_records_active_prefix
    ON master_records (source_prefix)
    WHERE deleted_at IS NULL;
