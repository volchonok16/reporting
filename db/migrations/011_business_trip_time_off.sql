-- Командировки в графике отсутствий.
-- Применение: ./scripts/migrate.sh 011_business_trip_time_off.sql

ALTER TABLE employee_time_off_day
    DROP CONSTRAINT IF EXISTS employee_time_off_day_kind_check;

ALTER TABLE employee_time_off_day
    ADD CONSTRAINT employee_time_off_day_kind_check
    CHECK (kind IN ('vacation', 'dayoff', 'sick_leave', 'business_trip'));

COMMENT ON TABLE employee_time_off_day IS 'График отсутствий: отпуск, отгул, больничный, командировка по дням';
COMMENT ON COLUMN employee_time_off_day.kind IS 'vacation | dayoff | sick_leave | business_trip';
