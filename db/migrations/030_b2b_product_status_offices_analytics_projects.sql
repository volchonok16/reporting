-- Новые вкладки «Статус продукта B2B»: Аналитики и Проекты.
-- Применение: ./scripts/migrate.sh 030_b2b_product_status_offices_analytics_projects.sql

INSERT INTO b2b_product_status_office (gid, name, sort_order) VALUES
    ('analytics', 'Офис: Аналитики', 80),
    ('projects', 'Офис: Проекты (Саша и Ваня)', 90)
ON CONFLICT (gid) DO NOTHING;
