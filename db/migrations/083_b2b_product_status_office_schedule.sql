-- Расписание автоблокировки отдельно по каждому офису статуса.

CREATE TABLE IF NOT EXISTS b2b_product_status_office_schedule (
    office_id  BIGINT NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    job_key    TEXT NOT NULL CHECK (job_key IN ('b2b_status_lock', 'b2b_status_unlock')),
    weekday    SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    minutes    SMALLINT NOT NULL CHECK (minutes BETWEEN 0 AND 1439),
    PRIMARY KEY (office_id, job_key)
);

COMMENT ON TABLE b2b_product_status_office_schedule IS
    'День и время автоблокировки офиса статуса по Москве. weekday: 0 понедельник … 6 воскресенье';
COMMENT ON COLUMN b2b_product_status_office_schedule.job_key IS
    'b2b_status_lock или b2b_status_unlock';
COMMENT ON COLUMN b2b_product_status_office_schedule.minutes IS
    'Минуты от полуночи Europe/Moscow';

INSERT INTO b2b_product_status_office_schedule (office_id, job_key, weekday, minutes)
SELECT o.id, s.job_key, s.weekday, s.minutes
FROM b2b_product_status_office AS o
JOIN b2b_product_status_schedule AS s
  ON s.job_key IN ('b2b_status_lock', 'b2b_status_unlock')
ON CONFLICT (office_id, job_key) DO NOTHING;

INSERT INTO b2b_product_status_office_schedule (office_id, job_key, weekday, minutes)
SELECT o.id, v.job_key, v.weekday, v.minutes
FROM b2b_product_status_office AS o
CROSS JOIN (
    VALUES
        ('b2b_status_lock', 3, 570),
        ('b2b_status_unlock', 3, 1080)
) AS v(job_key, weekday, minutes)
ON CONFLICT (office_id, job_key) DO NOTHING;

DELETE FROM b2b_product_status_schedule
WHERE job_key IN ('b2b_status_lock', 'b2b_status_unlock');
