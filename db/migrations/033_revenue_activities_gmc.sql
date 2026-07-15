-- jmc → gmc в колонке влияния

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, Влияние на базу/выручку/gmc, Комментарий, Результат (сумма числовых) → текст ячейки';

UPDATE revenue_activity_row
SET cells = (cells - 'Влияние на jmc')
    || jsonb_build_object(
      'Влияние на gmc',
      COALESCE(NULLIF(cells->>'Влияние на gmc', ''), cells->>'Влияние на jmc', '')
    ),
    updated_at = NOW()
WHERE cells ? 'Влияние на jmc';
