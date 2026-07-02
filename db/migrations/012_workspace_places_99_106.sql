-- Дополнительные рабочие места для брони.
-- Применение: ./scripts/migrate.sh 012_workspace_places_99_106.sql

INSERT INTO workspace_place (name, sort_order)
SELECT 'Место ' || n, n
FROM unnest(ARRAY[99, 100, 101, 102, 103, 104, 105, 106]) AS n
WHERE NOT EXISTS (
    SELECT 1 FROM workspace_place wp WHERE wp.sort_order = n
);
