-- Удаление допполя «Желаемый квартал» из ЗНИ
-- ./scripts/migrate.sh db/migrations/064_zni_drop_desired_quarter.sql

ALTER TABLE zni_external_data
    DROP COLUMN IF EXISTS desired_quarter;
