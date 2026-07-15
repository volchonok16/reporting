-- Историческая миграция единиц тыс/млн и удаления Результат.
-- Не перезаписывает cells: aliases читаются в backend (_COLUMN_SOURCE_KEYS).

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, Статус F2 2026, Ответственный, влияния (тыс/млн), Комментарий';

SELECT 1;
