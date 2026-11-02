-- Убрать размер (сложность) из скоринга ЗНИ.
-- ./scripts/migrate.sh db/migrations/093_zni_scoring_drop_size.sql

ALTER TABLE zni_external_data DROP CONSTRAINT IF EXISTS zni_external_data_score_size_check;
ALTER TABLE zni_external_data DROP COLUMN IF EXISTS score_size;
