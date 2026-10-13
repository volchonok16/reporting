-- Фиксированные приоритеты для каждого проекта координации B2B.
-- Применение: ./scripts/migrate.sh db/migrations/071_b2b_product_status_project_priorities.sql

CREATE TABLE IF NOT EXISTS b2b_product_status_project_priority (
    id              BIGSERIAL PRIMARY KEY,
    project_id      BIGINT       NOT NULL REFERENCES b2b_product_status_project(id) ON DELETE CASCADE,
    name            TEXT         NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_b2b_product_status_project_priority_project
    ON b2b_product_status_project_priority (project_id, sort_order, id);

COMMENT ON TABLE b2b_product_status_project_priority IS
    'Фиксированные приоритеты проекта координации; значение name пишется в cells.«Приоритет»';
COMMENT ON COLUMN b2b_product_status_project_priority.name IS
    'Отображаемое значение приоритета (например 1…5)';
COMMENT ON COLUMN b2b_product_status_project_priority.sort_order IS
    'Порядок в выпадающем списке';

-- Досеять проекты координации для офисов с gid из 047 и локальных алиасов (VOICE, m2m…).
INSERT INTO b2b_product_status_project (office_id, name, sort_order)
SELECT o.id, v.name, v.sort_order
FROM b2b_product_status_office AS o
JOIN (
    VALUES
        ('1512199647', 'SMS Hub', 10),
        ('1512199647', 'SMS-Таргет', 20),
        ('1512199647', 'SMS', 30),
        ('1699821818', 'Маркировка/МАВ', 10),
        ('1699821818', 'Мобильная карусель', 20),
        ('1699821818', 'КАТС', 30),
        ('1699821818', 'ВАТС(манго)', 40),
        ('1699821818', 'FMC (CVPN)', 50),
        ('VOICE', 'Маркировка/МАВ', 10),
        ('VOICE', 'Мобильная карусель', 20),
        ('VOICE', 'КАТС', 30),
        ('VOICE', 'ВАТС(манго)', 40),
        ('VOICE', 'FMC (CVPN)', 50),
        ('1909385714', 'T2 Облако', 10),
        ('1909385714', 'Юмнико', 20),
        ('1909385714', 'Big Data', 30),
        ('1909385714', 'Турплатформа', 40),
        ('1909385714', 'Геоплатформа', 50),
        ('1909385714', 'кибербезопасность', 60),
        ('102191664', 'Защищенный APN', 10),
        ('102191664', 'КСКТ', 20),
        ('102191664', 'CSD', 30),
        ('102191664', 'SCEF и NIDD', 40),
        ('m2m', 'Защищенный APN', 10),
        ('m2m', 'КСКТ', 20),
        ('m2m', 'CSD', 30),
        ('m2m', 'SCEF и NIDD', 40),
        ('M2M', 'Защищенный APN', 10),
        ('M2M', 'КСКТ', 20),
        ('M2M', 'CSD', 30),
        ('M2M', 'SCEF и NIDD', 40),
        ('128901598', 'Performance', 10),
        ('128901598', 'PR', 20),
        ('128901598', 'SEO', 30),
        ('128901598', 'Toolkit B2B', 40),
        ('128901598', 'POSM', 50)
) AS v(gid, name, sort_order) ON lower(v.gid) = lower(o.gid)
WHERE o.is_active = TRUE
ON CONFLICT (office_id, name) DO NOTHING;

-- Для каждого активного проекта — фиксированный набор 1…5 (идемпотентно).
INSERT INTO b2b_product_status_project_priority (project_id, name, sort_order)
SELECT p.id, v.name, v.sort_order
FROM b2b_product_status_project AS p
CROSS JOIN (
    VALUES
        ('1', 10),
        ('2', 20),
        ('3', 30),
        ('4', 40),
        ('5', 50)
) AS v(name, sort_order)
WHERE p.is_active = TRUE
ON CONFLICT (project_id, name) DO NOTHING;
