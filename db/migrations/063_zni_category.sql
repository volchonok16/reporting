-- Справочник категорий ЗНИ + поле category_id в допполях
-- ./scripts/migrate.sh db/migrations/063_zni_category.sql

CREATE TABLE IF NOT EXISTS zni_category (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_zni_category_name
    ON zni_category (lower(name));

COMMENT ON TABLE zni_category IS 'Справочник категорий ЗНИ для допполя «Категория»';
COMMENT ON COLUMN zni_category.name IS 'Название категории';
COMMENT ON COLUMN zni_category.sort_order IS 'Порядок в списке выбора';
COMMENT ON COLUMN zni_category.is_active IS 'Активна (показывается в селекте)';

INSERT INTO zni_category (name, sort_order, is_active)
SELECT v.name, v.sort_order, TRUE
FROM (
    VALUES
        ('Госинициативы', 1),
        ('Флайты', 2),
        ('Качественные (без эффекта)', 3),
        ('Операционка (без денег)', 4),
        ('Операционка (с деньгами)', 5),
        ('Решения руководства', 6),
        ('Проект ком.эффектом', 7)
) AS v(name, sort_order)
WHERE NOT EXISTS (
    SELECT 1 FROM zni_category c WHERE lower(c.name) = lower(v.name)
);

ALTER TABLE zni_external_data
    ADD COLUMN IF NOT EXISTS category_id BIGINT REFERENCES zni_category(id) ON DELETE SET NULL;

COMMENT ON COLUMN zni_external_data.category_id IS 'Категория ЗНИ (справочник zni_category)';

CREATE INDEX IF NOT EXISTS idx_zni_external_data_category
    ON zni_external_data (category_id);
