-- Разбить «Офис: Аналитики» на планирование и бизнес-анализ.
-- ./scripts/migrate.sh db/migrations/044_b2b_product_status_analytics_split.sql

INSERT INTO b2b_product_status_office (gid, name, sort_order) VALUES
    ('analytics_planning', 'Офис: Аналитики: планирование', 80),
    ('analytics_business', 'Офис: Аналитики: бизнес-анализа', 85)
ON CONFLICT (gid) DO UPDATE
SET
    name = EXCLUDED.name,
    sort_order = EXCLUDED.sort_order,
    is_active = TRUE;

-- Старая вкладка «Офис: Аналитики» скрывается (строки/история сохраняются).
UPDATE b2b_product_status_office
SET is_active = FALSE
WHERE gid = 'analytics';
