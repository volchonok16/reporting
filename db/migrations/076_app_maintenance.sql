-- Режим обслуживания: запрет авторизации обычным пользователям + сообщение о работах.
-- Массовый logout — DELETE из auth_session (см. API /api/admin/sessions/revoke-all).

CREATE TABLE IF NOT EXISTS app_maintenance (
    id                      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
    message                 TEXT NOT NULL DEFAULT '',
    allow_admin             BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by_org_user_id  BIGINT REFERENCES org_user(id) ON DELETE SET NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app_maintenance IS
    'Singleton: режим обслуживания (запрет входа не-админам) и текст сообщения пользователям';
COMMENT ON COLUMN app_maintenance.enabled IS
    'Если true — вход для обычных пользователей запрещён; сессии не-админов отклоняются';
COMMENT ON COLUMN app_maintenance.message IS
    'Текст о проводимых работах (логин, баннер, экран блокировки)';
COMMENT ON COLUMN app_maintenance.allow_admin IS
    'Если true — admin/superadmin/PAT могут входить и работать во время обслуживания';

INSERT INTO app_maintenance (id, enabled, message, allow_admin)
VALUES (1, FALSE, '', TRUE)
ON CONFLICT (id) DO NOTHING;
