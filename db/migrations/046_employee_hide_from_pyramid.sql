-- Скрыть сотрудника в пирамиде (оргструктура)
-- ./scripts/migrate.sh db/migrations/046_employee_hide_from_pyramid.sql

ALTER TABLE employee
    ADD COLUMN IF NOT EXISTS hide_from_pyramid BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN employee.hide_from_pyramid IS
    'Если true — сотрудник не показывается в пирамиде (вкладка «Пирамида»)';
