-- Две вкладки «Активности по выручкам»:
--   base     → «Влияние по базе» (колонка влияния на базу)
--   revenue  → «Влияние по выручке» (колонка влияния на выручку)
-- Данные из main копируются в обе вкладки; main деактивируется.

INSERT INTO revenue_activity_section (gid, name, sort_order) VALUES
    ('base', 'Влияние по базе', 10),
    ('revenue', 'Влияние по выручке', 20)
ON CONFLICT (gid) DO UPDATE SET
    name = EXCLUDED.name,
    sort_order = EXCLUDED.sort_order,
    is_active = TRUE;

-- Копируем строки из main только если у целевой вкладки ещё нет строк
INSERT INTO revenue_activity_row (section_id, sort_order, cells, created_at, updated_at)
SELECT
    target.id,
    src.sort_order,
    src.cells,
    NOW(),
    NOW()
FROM revenue_activity_row src
JOIN revenue_activity_section main_sec
    ON main_sec.id = src.section_id AND main_sec.gid = 'main'
JOIN revenue_activity_section target
    ON target.gid = 'base'
WHERE NOT EXISTS (
    SELECT 1 FROM revenue_activity_row existing WHERE existing.section_id = target.id
);

INSERT INTO revenue_activity_row (section_id, sort_order, cells, created_at, updated_at)
SELECT
    target.id,
    src.sort_order,
    src.cells,
    NOW(),
    NOW()
FROM revenue_activity_row src
JOIN revenue_activity_section main_sec
    ON main_sec.id = src.section_id AND main_sec.gid = 'main'
JOIN revenue_activity_section target
    ON target.gid = 'revenue'
WHERE NOT EXISTS (
    SELECT 1 FROM revenue_activity_row existing WHERE existing.section_id = target.id
);

UPDATE revenue_activity_section
SET is_active = FALSE,
    name = 'Активности по выручкам (архив)'
WHERE gid = 'main';
