-- Настраиваемое расписание статуса продукта. Меняет только суперадминистратор (org_user.role = 1000).

CREATE TABLE IF NOT EXISTS b2b_product_status_schedule (
    job_key  TEXT PRIMARY KEY,
    weekday  SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    minutes  SMALLINT NOT NULL CHECK (minutes BETWEEN 0 AND 1439)
);

COMMENT ON TABLE b2b_product_status_schedule IS
    'День и время заданий статуса продукта по Москве. weekday: 0 понедельник … 6 воскресенье';
COMMENT ON COLUMN b2b_product_status_schedule.job_key IS
    'b2b_status_reminder, b2b_status_lock, b2b_status_unlock';
COMMENT ON COLUMN b2b_product_status_schedule.minutes IS
    'Минуты от полуночи Europe/Moscow';

INSERT INTO b2b_product_status_schedule (job_key, weekday, minutes)
VALUES
    ('b2b_status_reminder', 2, 600),
    ('b2b_status_lock', 3, 570),
    ('b2b_status_unlock', 3, 1080)
ON CONFLICT (job_key) DO NOTHING;
