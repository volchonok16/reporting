-- Справочник «Департамент заказчика» для планирования (отдельно от department Staffing)
-- ./scripts/migrate.sh db/migrations/042_planning_customer_department.sql

CREATE TABLE IF NOT EXISTS planning_customer_department (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_planning_customer_department_name
    ON planning_customer_department (lower(name));

COMMENT ON TABLE planning_customer_department IS 'Справочник департаментов заказчика для планирования (не связан с department Staffing)';

-- Снять FK на org department (Staffing)
ALTER TABLE planning_project
    DROP CONSTRAINT IF EXISTS planning_project_customer_department_id_fkey;

-- Старые id указывали на department — обнуляем
UPDATE planning_project
SET customer_department_id = NULL
WHERE customer_department_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM planning_customer_department d WHERE d.id = planning_project.customer_department_id
  );

ALTER TABLE planning_project
    ADD CONSTRAINT planning_project_customer_department_id_fkey
    FOREIGN KEY (customer_department_id)
    REFERENCES planning_customer_department(id)
    ON DELETE SET NULL;
