-- Самоотметка "в офисе" без брони места.
-- Применение: ./scripts/migrate.sh 009_employee_office_days.sql

CREATE TABLE IF NOT EXISTS employee_office_day (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    day             DATE         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, day)
);

CREATE INDEX IF NOT EXISTS idx_employee_office_day_day
    ON employee_office_day (day);

CREATE INDEX IF NOT EXISTS idx_employee_office_day_employee_day
    ON employee_office_day (employee_id, day);

COMMENT ON TABLE employee_office_day
    IS 'Дни присутствия сотрудника в офисе без привязки к месту (самоотметка)';
