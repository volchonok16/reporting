-- Отметка, что плановое задание статуса продукта уже выполнено в этот день.
-- Применение: ./scripts/migrate.sh db/migrations/078_app_scheduled_job_run.sql

CREATE TABLE IF NOT EXISTS app_scheduled_job_run (
    job_key   TEXT        PRIMARY KEY,
    ran_on    DATE        NOT NULL,
    ran_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app_scheduled_job_run IS
    'Последний день выполнения планового задания (напоминание и блокировка статуса продукта)';
COMMENT ON COLUMN app_scheduled_job_run.job_key IS
    'Ключ задания: b2b_status_reminder, b2b_status_lock, b2b_status_unlock';
COMMENT ON COLUMN app_scheduled_job_run.ran_on IS
    'Календарный день Europe/Moscow, за который задание уже выполнено';
