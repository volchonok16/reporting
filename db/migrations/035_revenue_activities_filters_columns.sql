-- Переименование колонок, удаление «Результат», единицы измерения

COMMENT ON COLUMN revenue_activity_row.cells IS
  'JSON: Активность, Статус F2 2026, Ответственный, влияния (тыс/млн), Комментарий';

UPDATE revenue_activity_row
SET cells = (
      jsonb_strip_nulls(
        jsonb_build_object(
          'Активность', COALESCE(cells->>'Активность', ''),
          'Статус F2 2026', COALESCE(
            NULLIF(cells->>'Статус F2 2026', ''),
            cells->>'Статус',
            ''
          ),
          'Ответственный', COALESCE(cells->>'Ответственный', ''),
          'Влияние на базу, тыс', COALESCE(
            NULLIF(cells->>'Влияние на базу, тыс', ''),
            cells->>'Влияние на базу',
            ''
          ),
          'Влияние на выручку, млн', COALESCE(
            NULLIF(cells->>'Влияние на выручку, млн', ''),
            cells->>'Влияние на выручку',
            ''
          ),
          'Влияние на gmc, млн', COALESCE(
            NULLIF(cells->>'Влияние на gmc, млн', ''),
            cells->>'Влияние на gmc',
            cells->>'Влияние на jmc',
            ''
          ),
          'Комментарий', COALESCE(cells->>'Комментарий', '')
        )
      )
    ),
    updated_at = NOW();
