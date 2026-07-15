-- Историческая data-миграция колонок «Активности по выручкам».
-- Не перезаписывает cells: переименование ключей читается в приложении (_COLUMN_SOURCE_KEYS).

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, влияния, Комментарий (и др. колонки); старые ключи читаются backend без UPDATE';

SELECT 1;
