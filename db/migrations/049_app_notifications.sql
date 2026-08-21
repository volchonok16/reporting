-- Внутренние уведомления пользователям приложения
-- ./scripts/migrate.sh db/migrations/049_app_notifications.sql

CREATE TABLE IF NOT EXISTS app_notification (
    id                      BIGSERIAL PRIMARY KEY,
    title                   VARCHAR(255) NOT NULL,
    body                    TEXT         NOT NULL,
    audience                VARCHAR(32)  NOT NULL,
    created_by_org_user_id  BIGINT       REFERENCES org_user(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT app_notification_audience_chk
        CHECK (audience IN ('all', 'users', 'departments'))
);

CREATE TABLE IF NOT EXISTS app_notification_recipient (
    id               BIGSERIAL PRIMARY KEY,
    notification_id  BIGINT NOT NULL REFERENCES app_notification(id) ON DELETE CASCADE,
    org_user_id      BIGINT NOT NULL REFERENCES org_user(id) ON DELETE CASCADE,
    read_at          TIMESTAMPTZ,
    popup_shown_at   TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (notification_id, org_user_id)
);

CREATE INDEX IF NOT EXISTS idx_app_notification_created
    ON app_notification (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_notification_recipient_user
    ON app_notification_recipient (org_user_id, read_at, created_at DESC);

COMMENT ON TABLE app_notification IS 'Уведомление приложения (всем / пользователям / отделам)';
COMMENT ON COLUMN app_notification.audience IS 'all | users | departments';
COMMENT ON COLUMN app_notification.created_by_org_user_id IS 'Автор (org_user); NULL для PAT';
COMMENT ON TABLE app_notification_recipient IS 'Получатель уведомления (развёрнутый список org_user)';
COMMENT ON COLUMN app_notification_recipient.read_at IS 'Когда пользователь прочитал';
COMMENT ON COLUMN app_notification_recipient.popup_shown_at IS 'Когда показали всплывающее уведомление';
