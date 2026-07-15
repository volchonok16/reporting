-- Историческая миграция jmc→gmc.
-- Не перезаписывает cells: ключ «Влияние на jmc» читается как alias в backend.

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, влияния (в т.ч. gmc), Комментарий; legacy jmc читается без UPDATE';

SELECT 1;
