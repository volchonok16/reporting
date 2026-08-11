-- Справочник проектов координации по офисам B2B.
-- Применение: ./scripts/migrate.sh 047_b2b_product_status_projects.sql

CREATE TABLE IF NOT EXISTS b2b_product_status_project (
    id              BIGSERIAL PRIMARY KEY,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    name            TEXT         NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (office_id, name)
);

CREATE INDEX IF NOT EXISTS idx_b2b_product_status_project_office
    ON b2b_product_status_project (office_id, sort_order, id);

COMMENT ON TABLE b2b_product_status_project IS 'Справочник проектов координации для офисов B2B (мультиселект в колонке «Проект координация»)';
COMMENT ON COLUMN b2b_product_status_project.name IS 'Отображаемое имя проекта';
COMMENT ON COLUMN b2b_product_status_project.sort_order IS 'Порядок в выпадающем списке';

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
        ('128901598', 'Performance', 10),
        ('128901598', 'PR', 20),
        ('128901598', 'SEO', 30),
        ('128901598', 'Toolkit B2B', 40),
        ('128901598', 'POSM', 50)
) AS v(gid, name, sort_order) ON v.gid = o.gid
ON CONFLICT (office_id, name) DO NOTHING;
