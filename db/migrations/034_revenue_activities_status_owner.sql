-- Вернуть текстовые колонки «Статус» и «Ответственный» в «Активности по выручкам»

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, Статус, Ответственный, влияния база/выручка/gmc, Комментарий, Результат (сумма) → текст ячейки';

UPDATE revenue_activity_row
SET cells = cells
    || jsonb_build_object(
      'Статус', COALESCE(cells->>'Статус', ''),
      'Ответственный', COALESCE(cells->>'Ответственный', '')
    ),
    updated_at = NOW()
WHERE NOT (cells ? 'Статус')
   OR NOT (cells ? 'Ответственный');
