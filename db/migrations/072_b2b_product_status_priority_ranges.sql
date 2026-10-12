-- Приоритеты проектов координации — числовые диапазоны (например 1–49, 50–70).
-- Применение: ./scripts/migrate.sh db/migrations/072_b2b_product_status_priority_ranges.sql

ALTER TABLE b2b_product_status_project_priority
    ADD COLUMN IF NOT EXISTS range_from INT,
    ADD COLUMN IF NOT EXISTS range_to INT;

COMMENT ON COLUMN b2b_product_status_project_priority.range_from IS
    'Начало диапазона приоритета (включительно)';
COMMENT ON COLUMN b2b_product_status_project_priority.range_to IS
    'Конец диапазона приоритета (включительно)';
COMMENT ON COLUMN b2b_product_status_project_priority.name IS
    'Подпись диапазона для UI/cells, например 1-49';

-- Убрать старые точечные значения 1…5 и любые строки без диапазона.
DELETE FROM b2b_product_status_project_priority
WHERE range_from IS NULL
   OR range_to IS NULL
   OR name ~ '^[0-9]+$';

-- Фиксированные диапазоны для каждого активного проекта.
INSERT INTO b2b_product_status_project_priority (
    project_id, name, sort_order, range_from, range_to
)
SELECT p.id, v.name, v.sort_order, v.range_from, v.range_to
FROM b2b_product_status_project AS p
CROSS JOIN (
    VALUES
        ('1-49',  10, 1,  49),
        ('50-70', 20, 50, 70),
        ('71-85', 30, 71, 85),
        ('86-95', 40, 86, 95),
        ('96-100', 50, 96, 100)
) AS v(name, sort_order, range_from, range_to)
WHERE p.is_active = TRUE
ON CONFLICT (project_id, name) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    range_from = EXCLUDED.range_from,
    range_to = EXCLUDED.range_to,
    is_active = TRUE;

ALTER TABLE b2b_product_status_project_priority
    ALTER COLUMN range_from SET NOT NULL,
    ALTER COLUMN range_to SET NOT NULL;

ALTER TABLE b2b_product_status_project_priority
    DROP CONSTRAINT IF EXISTS b2b_product_status_project_priority_range_check;

ALTER TABLE b2b_product_status_project_priority
    ADD CONSTRAINT b2b_product_status_project_priority_range_check
    CHECK (range_from >= 1 AND range_to >= range_from);
