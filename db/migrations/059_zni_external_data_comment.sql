-- Комментарий в дополнительных полях ЗНИ (дашборд).
-- ./scripts/migrate.sh db/migrations/059_zni_external_data_comment.sql

ALTER TABLE zni_external_data
    ADD COLUMN IF NOT EXISTS comment TEXT;

COMMENT ON COLUMN zni_external_data.comment IS 'Комментарий (внешнее поле, не TFS)';
