-- Колонки «Активности по выручкам»: Активность, влияния (числовые), Комментарий, Результат (сумма)

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, Влияние на базу/выручку/gmc, Комментарий, Результат (сумма числовых) → текст ячейки';

-- Перенос ключей Статус→Активность, старый Результат→Комментарий (если ещё старая схема)
UPDATE revenue_activity_row
SET cells = jsonb_build_object(
      'Активность', COALESCE(NULLIF(cells->>'Активность', ''), cells->>'Статус', ''),
      'Влияние на базу', COALESCE(cells->>'Влияние на базу', ''),
      'Влияние на выручку', COALESCE(cells->>'Влияние на выручку', ''),
      'Влияние на gmc', COALESCE(
        cells->>'Влияние на gmc',
        cells->>'Влияние на jmc',
        ''
      ),
      'Комментарий', COALESCE(
        NULLIF(cells->>'Комментарий', ''),
        CASE WHEN cells ? 'Статус' THEN cells->>'Результат' ELSE '' END,
        ''
      ),
      'Результат', CASE
        WHEN cells ? 'Статус' THEN ''
        ELSE COALESCE(cells->>'Результат', '')
      END
    ),
    updated_at = NOW()
WHERE cells ? 'Статус'
   OR cells ? 'Ответственный'
   OR cells ? 'Влияние на jmc'
   OR NOT (cells ? 'Активность');
