-- Исполнители проекта (множественный выбор)
-- ./scripts/migrate.sh db/migrations/040_planning_project_executors.sql

CREATE TABLE IF NOT EXISTS planning_project_executor (
    id              BIGSERIAL PRIMARY KEY,
    project_id      BIGINT       NOT NULL REFERENCES planning_project(id) ON DELETE CASCADE,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_planning_project_executor_project ON planning_project_executor (project_id);
CREATE INDEX IF NOT EXISTS idx_planning_project_executor_employee ON planning_project_executor (employee_id);

COMMENT ON TABLE planning_project_executor IS 'Исполнители проекта планирования (ручной выбор + автодобавление из выделений)';

INSERT INTO planning_project_executor (project_id, employee_id)
SELECT id, customer_employee_id
FROM planning_project
WHERE customer_employee_id IS NOT NULL
ON CONFLICT (project_id, employee_id) DO NOTHING;

-- Сотрудники с назначенным временем в выделениях
INSERT INTO planning_project_executor (project_id, employee_id)
SELECT DISTINCT a.project_id, a.employee_id
FROM planning_allocation a
JOIN planning_allocation_day d ON d.allocation_id = a.id
WHERE d.planned_hours > 0 OR d.actual_hours > 0
ON CONFLICT (project_id, employee_id) DO NOTHING;
