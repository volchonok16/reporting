-- Колонка «Маржа» во вкладке «Влияние по выручке» (gid=revenue).
-- Не перезаписывает cells: колонка добавляется в backend REVENUE_ACTIVITY_SECTION_COLUMNS.

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, Статус F2 2026, Ответственный, влияния (база/выручка/gmc), Маржа (revenue), Комментарий';

SELECT 1;
