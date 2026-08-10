-- Флаг «Voice сервисы»: пользователь видит только вкладку Voice
-- ./scripts/migrate.sh db/migrations/045_org_user_voice_only.sql

ALTER TABLE org_user
    ADD COLUMN IF NOT EXISTS voice_only BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN org_user.voice_only IS
    'Если true — доступ только к вкладке Voice; проставляет только администратор';
