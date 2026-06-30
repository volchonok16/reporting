-- Организационная структура: отделы, сотрудники, учётные записи
-- Применять: ./scripts/migrate.sh 005_org_structure.sql

CREATE TABLE IF NOT EXISTS org_user (
    id              BIGSERIAL PRIMARY KEY,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   TEXT         NOT NULL,
    role            SMALLINT     NOT NULL DEFAULT 10,  -- 10=user, 100=admin
    status          SMALLINT     NOT NULL DEFAULT 10,  -- 0=deleted, 9=inactive, 10=active
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE org_user IS 'Учётные записи сотрудников для входа в приложение';
COMMENT ON COLUMN org_user.role IS '10 — пользователь, 100 — администратор отделов';

CREATE TABLE IF NOT EXISTS job_position (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL UNIQUE,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE job_position IS 'Справочник должностей';

CREATE TABLE IF NOT EXISTS team_role (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE team_role IS 'Роли сотрудника в составе отдела';

CREATE TABLE IF NOT EXISTS expertise_direction (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE expertise_direction IS 'Направления экспертизы сотрудников';

CREATE TABLE IF NOT EXISTS employee (
    id                      BIGSERIAL PRIMARY KEY,
    user_id                 BIGINT       REFERENCES org_user(id) ON DELETE SET NULL,
    full_name               VARCHAR(255) NOT NULL,
    email                   VARCHAR(255),
    position_id             BIGINT       REFERENCES job_position(id) ON DELETE SET NULL,
    position                VARCHAR(255),
    manager_id              BIGINT       REFERENCES employee(id) ON DELETE SET NULL,
    photo_path              VARCHAR(512),
    daily_work_hours        NUMERIC(4, 2) NOT NULL DEFAULT 8,
    is_active               BOOLEAN      NOT NULL DEFAULT TRUE,
    is_organization_head    BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_full_name ON employee (full_name);
CREATE INDEX IF NOT EXISTS idx_employee_manager_id ON employee (manager_id);

COMMENT ON TABLE employee IS 'Сотрудники организации';
COMMENT ON COLUMN employee.is_organization_head IS 'Директор организации — вершина общей пирамиды';

CREATE TABLE IF NOT EXISTS employee_expertise (
    id                      BIGSERIAL PRIMARY KEY,
    employee_id             BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    expertise_direction_id  BIGINT       NOT NULL REFERENCES expertise_direction(id) ON DELETE CASCADE,
    level                   VARCHAR(64),
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, expertise_direction_id)
);

COMMENT ON TABLE employee_expertise IS 'Экспертиза сотрудника по направлениям';

CREATE TABLE IF NOT EXISTS department (
    id                  BIGSERIAL PRIMARY KEY,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    head_employee_id    BIGINT       REFERENCES employee(id) ON DELETE SET NULL,
    sort_order          INT          NOT NULL DEFAULT 0,
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_department_name ON department (name);

COMMENT ON TABLE department IS 'Отделы организации';

CREATE TABLE IF NOT EXISTS department_member (
    id              BIGSERIAL PRIMARY KEY,
    department_id   BIGINT       NOT NULL REFERENCES department(id) ON DELETE CASCADE,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    team_role_id    BIGINT       REFERENCES team_role(id) ON DELETE SET NULL,
    position        VARCHAR(255),
    manager_id      BIGINT       REFERENCES employee(id) ON DELETE SET NULL,
    email           VARCHAR(255),
    sort_order      INT          NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (department_id, employee_id)
);

COMMENT ON TABLE department_member IS 'Состав отдела; manager_id — руководитель в контексте отдела';

INSERT INTO team_role (name, sort_order)
SELECT v.name, v.sort_order
FROM (VALUES
    ('Руководитель', 10),
    ('Ведущий', 20),
    ('Старший', 30),
    ('Специалист', 40)
) AS v(name, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM team_role LIMIT 1);
