-- Планирование: проекты, выделение ресурсов, производственный календарь
-- ./scripts/migrate.sh db/migrations/016_planning.sql

CREATE TABLE IF NOT EXISTS planning_project_complexity (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE planning_project_complexity IS 'Справочник сложности проектов планирования';

INSERT INTO planning_project_complexity (name, sort_order)
SELECT v.name, v.sort_order
FROM (VALUES
    ('Низкая', 10),
    ('Средняя', 20),
    ('Высокая', 30),
    ('Критическая', 40)
) AS v(name, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM planning_project_complexity LIMIT 1);

CREATE TABLE IF NOT EXISTS production_calendar_day (
    day             DATE         PRIMARY KEY,
    is_working_day  BOOLEAN      NOT NULL,
    title           VARCHAR(255),
    note            TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE production_calendar_day IS 'Производственный календарь: переопределения рабочих/нерабочих дней';
COMMENT ON COLUMN production_calendar_day.is_working_day IS 'TRUE — рабочий день, FALSE — выходной/праздник';

CREATE TABLE IF NOT EXISTS planning_project (
    id                      BIGSERIAL PRIMARY KEY,
    request_number          VARCHAR(64)   NOT NULL,
    request_name            VARCHAR(512)  NOT NULL,
    request_url             VARCHAR(1024),
    complexity_id           BIGINT        REFERENCES planning_project_complexity(id) ON DELETE SET NULL,
    customer_employee_id    BIGINT        REFERENCES employee(id) ON DELETE SET NULL,
    customer_name           VARCHAR(255),
    customer_department_id  BIGINT        REFERENCES department(id) ON DELETE SET NULL,
    planned_start_date      DATE,
    actual_start_date       DATE,
    planned_end_date        DATE,
    actual_end_date         DATE,
    notes                   TEXT,
    created_by_org_user_id  BIGINT        REFERENCES org_user(id) ON DELETE SET NULL,
    created_by_label        VARCHAR(255),
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planning_project_request_number ON planning_project (request_number);
CREATE INDEX IF NOT EXISTS idx_planning_project_customer_department ON planning_project (customer_department_id);
CREATE INDEX IF NOT EXISTS idx_planning_project_dates ON planning_project (planned_start_date, planned_end_date);

COMMENT ON TABLE planning_project IS 'Проекты/запросы планирования ресурсов';
COMMENT ON COLUMN planning_project.request_number IS 'Номер запроса';
COMMENT ON COLUMN planning_project.request_name IS 'Наименование запроса';
COMMENT ON COLUMN planning_project.request_url IS 'Ссылка на запрос (TFS/Jira и т.д.)';

CREATE TABLE IF NOT EXISTS planning_allocation (
    id                      BIGSERIAL PRIMARY KEY,
    project_id              BIGINT        NOT NULL REFERENCES planning_project(id) ON DELETE CASCADE,
    employee_id             BIGINT        NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    allocation_start_date   DATE          NOT NULL,
    allocation_end_date     DATE          NOT NULL,
    booking_mode            VARCHAR(16)   NOT NULL DEFAULT 'period'
        CHECK (booking_mode IN ('daily', 'period')),
    planned_hours_per_day   NUMERIC(5, 2),
    created_by_org_user_id  BIGINT        REFERENCES org_user(id) ON DELETE SET NULL,
    created_by_label        VARCHAR(255),
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CHECK (allocation_end_date >= allocation_start_date)
);

CREATE INDEX IF NOT EXISTS idx_planning_allocation_project ON planning_allocation (project_id);
CREATE INDEX IF NOT EXISTS idx_planning_allocation_employee ON planning_allocation (employee_id);
CREATE INDEX IF NOT EXISTS idx_planning_allocation_dates ON planning_allocation (allocation_start_date, allocation_end_date);

COMMENT ON TABLE planning_allocation IS 'Выделение сотрудника на проект планирования';
COMMENT ON COLUMN planning_allocation.booking_mode IS 'period — часы на весь период по рабочим дням; daily — подневная сетка';
COMMENT ON COLUMN planning_allocation.planned_hours_per_day IS 'Плановые часы на рабочий день (режим period)';

CREATE TABLE IF NOT EXISTS planning_allocation_day (
    id              BIGSERIAL PRIMARY KEY,
    allocation_id   BIGINT        NOT NULL REFERENCES planning_allocation(id) ON DELETE CASCADE,
    day             DATE          NOT NULL,
    planned_hours   NUMERIC(5, 2) NOT NULL DEFAULT 0,
    actual_hours    NUMERIC(5, 2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (allocation_id, day)
);

CREATE INDEX IF NOT EXISTS idx_planning_allocation_day_day ON planning_allocation_day (day);

COMMENT ON TABLE planning_allocation_day IS 'Подневная занятость и факт по выделению ресурса';
