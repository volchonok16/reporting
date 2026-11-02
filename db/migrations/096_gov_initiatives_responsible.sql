-- Госинициативы: колонка «Ответственный» после «Номер ЗнИ».
-- Не перезаписывает cells: колонка добавляется в backend GOV_INITIATIVE_SECTION_COLUMNS.
-- ./scripts/migrate.sh db/migrations/096_gov_initiatives_responsible.sql

COMMENT ON TABLE gov_initiative_row IS
    'Строка таблицы госинициатив; cells — Закон / Описание / Дата запуска / Статус / Номер ЗнИ / Ответственный';
COMMENT ON COLUMN gov_initiative_row.cells IS
    'JSON: Закон, Описание, Дата запуска, Статус, Номер ЗнИ, Ответственный → текст ячейки';

SELECT 1;
