-- Один диапазон приоритета на проект внутри офиса; в ячейке — одно число из диапазона.
-- Пример: SCEF и NIDD → 1–49, строки получают 1, 2, 3…
-- Применение: ./scripts/migrate.sh db/migrations/073_b2b_product_status_one_range_per_project.sql

-- Предпочтительный порядок проектов M2M: SCEF и NIDD → диапазон 1–49.
UPDATE b2b_product_status_project AS p
SET sort_order = v.sort_order
FROM b2b_product_status_office AS o,
LATERAL (
    VALUES
        ('SCEF и NIDD', 10),
        ('Защищенный APN', 20),
        ('КСКТ', 30),
        ('CSD', 40)
) AS v(name, sort_order)
WHERE p.office_id = o.id
  AND lower(o.gid) IN ('m2m', '102191664')
  AND p.name = v.name;

DELETE FROM b2b_product_status_project_priority;

WITH ranked AS (
    SELECT
        p.id AS project_id,
        row_number() OVER (
            PARTITION BY p.office_id
            ORDER BY p.sort_order, p.id
        ) AS rn
    FROM b2b_product_status_project AS p
    WHERE p.is_active = TRUE
),
bands AS (
    SELECT *
    FROM (
        VALUES
            (1, '1-49',   1,  49, 10),
            (2, '50-70',  50, 70, 20),
            (3, '71-85',  71, 85, 30),
            (4, '86-95',  86, 95, 40),
            (5, '96-100', 96, 100, 50)
    ) AS v(rn, name, range_from, range_to, sort_order)
)
INSERT INTO b2b_product_status_project_priority (
    project_id, name, sort_order, range_from, range_to
)
SELECT
    r.project_id,
    COALESCE(
        b.name,
        (100 + (r.rn - 6) * 20 + 1)::text || '-' || (100 + (r.rn - 5) * 20)::text
    ) AS name,
    COALESCE(b.sort_order, r.rn * 10) AS sort_order,
    COALESCE(b.range_from, 100 + (r.rn - 6) * 20 + 1) AS range_from,
    COALESCE(b.range_to, 100 + (r.rn - 5) * 20) AS range_to
FROM ranked AS r
LEFT JOIN bands AS b ON b.rn = r.rn
ON CONFLICT (project_id, name) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    range_from = EXCLUDED.range_from,
    range_to = EXCLUDED.range_to,
    is_active = TRUE;

COMMENT ON TABLE b2b_product_status_project_priority IS
    'Один диапазон приоритета на проект офиса; в cells.«Приоритет» хранится одно число из диапазона';
