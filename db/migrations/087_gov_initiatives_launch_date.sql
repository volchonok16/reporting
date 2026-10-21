-- Госинициативы: колонка «Дата запуска» после «Описание»;
-- порядок ячеек: Закон / Описание / Дата запуска / Статус / Номер ЗнИ
-- (порядок задаётся в backend GOV_INITIATIVE_SECTION_COLUMNS; cells — jsonb).

COMMENT ON TABLE gov_initiative_row IS
    'Строка таблицы госинициатив; cells — Закон / Описание / Дата запуска / Статус / Номер ЗнИ';
COMMENT ON COLUMN gov_initiative_row.cells IS
    'JSON: Закон, Описание, Дата запуска, Статус, Номер ЗнИ → текст ячейки';
