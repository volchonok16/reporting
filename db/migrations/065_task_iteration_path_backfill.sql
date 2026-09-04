-- Заполнить task.iteration_path из extra_json (раньше sync писал только в JSON).
-- ./scripts/migrate.sh db/migrations/065_task_iteration_path_backfill.sql

UPDATE task
SET iteration_path = left(nullif(btrim(extra_json->>'iteration_path'), ''), 500)
WHERE iteration_path IS NULL
  AND nullif(btrim(extra_json->>'iteration_path'), '') IS NOT NULL;

COMMENT ON COLUMN task.iteration_path IS 'Путь итерации TFS (System.IterationPath); заполняется при sync и дублируется в extra_json.iteration_path';
