-- График отпусков: один день — одна запись на сотрудника.
-- Применение: ./scripts/migrate.sh 006_vacation_schedule.sql

CREATE TABLE IF NOT EXISTS employee_time_off_day (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    day             DATE         NOT NULL,
    kind            VARCHAR(32)  NOT NULL CHECK (kind IN ('vacation', 'dayoff', 'sick_leave')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, day)
);

CREATE INDEX IF NOT EXISTS idx_employee_time_off_day_day
    ON employee_time_off_day (day);

CREATE INDEX IF NOT EXISTS idx_employee_time_off_day_employee_day
    ON employee_time_off_day (employee_id, day);

COMMENT ON TABLE employee_time_off_day IS 'График отпусков: отпуск, отгул, больничный по дням';
COMMENT ON COLUMN employee_time_off_day.kind IS 'vacation | dayoff | sick_leave';
