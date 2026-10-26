-- Заявленный квартал ЗНИ: локальное поле дашборда, не итерация TFS.

ALTER TABLE zni_external_data
    ADD COLUMN IF NOT EXISTS plan_quarter VARCHAR(16);

COMMENT ON COLUMN zni_external_data.plan_quarter IS
    'Заявленный квартал закрытия, канон YYYY-Qn (например 2026-Q1). Не из TFS.';
