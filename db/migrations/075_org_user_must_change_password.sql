-- Обязательная смена пароля после сброса / временного пароля 12345678.

ALTER TABLE org_user
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN org_user.must_change_password IS
    'Если true — пользователь обязан сменить пароль перед работой; окно нельзя закрыть, пока не задан новый пароль (не 12345678)';
