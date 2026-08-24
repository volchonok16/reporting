-- Роль «Администратор Voice»: очистка журнала/версии и очистка мастер-файла.
-- Назначает только администратор reporting (карточка сотрудника).

ALTER TABLE org_user
    ADD COLUMN IF NOT EXISTS voice_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN org_user.voice_admin IS
    'Администратор Voice: очистка журнала и обнуление версии, очистка мастер-файла';
