-- Норма отпуска на сотрудника + открытие планирования следующего года.
-- Праздники 2027 (переносы ПП РФ № 1187 от 17.09.2026) — в production_calendar_day.

ALTER TABLE employee
    ADD COLUMN IF NOT EXISTS annual_leave_days INT NOT NULL DEFAULT 28;

ALTER TABLE employee
    DROP CONSTRAINT IF EXISTS employee_annual_leave_days_check;
ALTER TABLE employee
    ADD CONSTRAINT employee_annual_leave_days_check
    CHECK (annual_leave_days >= 1 AND annual_leave_days <= 366);

COMMENT ON COLUMN employee.annual_leave_days IS
    'Норма отпускных дней в календарном году (по умолчанию 28); праздники в период отпуска не расходуют норму';

CREATE TABLE IF NOT EXISTS vacation_planning_unlock (
    year                    INT PRIMARY KEY,
    unlocked_by_org_user_id BIGINT REFERENCES org_user(id) ON DELETE SET NULL,
    unlocked_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vacation_planning_unlock IS
    'Годы, для которых суперадмин открыл планирование отпусков (редактирование следующего года)';

-- Доп. нерабочие дни 2027 (переносы + выходные, совпавшие с праздниками).
INSERT INTO production_calendar_day (day, is_working_day, title, note)
VALUES
    ('2027-02-22', FALSE, 'Перенос выходного', 'с 20.02.2027 (ПП РФ № 1187)'),
    ('2027-05-03', FALSE, 'Перенос выходного', 'с 01.05.2027'),
    ('2027-05-10', FALSE, 'Перенос выходного', 'с 09.05.2027'),
    ('2027-06-14', FALSE, 'Перенос выходного', 'с 12.06.2027'),
    ('2027-11-05', FALSE, 'Перенос выходного', 'с 02.01.2027 (ПП РФ № 1187)'),
    ('2027-12-31', FALSE, 'Перенос выходного', 'с 03.01.2027 (ПП РФ № 1187)')
ON CONFLICT (day) DO UPDATE
SET
    is_working_day = EXCLUDED.is_working_day,
    title = COALESCE(production_calendar_day.title, EXCLUDED.title),
    note = COALESCE(production_calendar_day.note, EXCLUDED.note);
