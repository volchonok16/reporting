-- Внешние поля ЗНИ (не из TFS): приоритет, коммерческий эффект, даты
-- ./scripts/migrate.sh db/migrations/048_zni_external_data.sql

CREATE TABLE IF NOT EXISTS zni_external_data (
    task_id              BIGINT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
    priority             VARCHAR(255),
    commercial_effect    TEXT,
    actual_period        VARCHAR(128),
    desired_date         DATE,
    desired_quarter      VARCHAR(64),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE zni_external_data IS 'Локальные поля ЗНИ, заполняются отдельно от синхронизации TFS';
COMMENT ON COLUMN zni_external_data.task_id IS 'ЗНИ (task.id, task_type = change_request)';
COMMENT ON COLUMN zni_external_data.priority IS 'Приоритет (внешний, не TFS)';
COMMENT ON COLUMN zni_external_data.commercial_effect IS 'Коммерческий эффект';
COMMENT ON COLUMN zni_external_data.actual_period IS 'Фактическая дата: месяц/квартал';
COMMENT ON COLUMN zni_external_data.desired_date IS 'Желаемая дата';
COMMENT ON COLUMN zni_external_data.desired_quarter IS 'Желаемый квартал';
