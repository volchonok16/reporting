-- ./scripts/migrate.sh db/migrations/061_app_notification_delivery.sql

ALTER TABLE app_notification
    ADD COLUMN IF NOT EXISTS delivery VARCHAR(16) NOT NULL DEFAULT 'inbox';

ALTER TABLE app_notification
    DROP CONSTRAINT IF EXISTS app_notification_delivery_chk;

ALTER TABLE app_notification
    ADD CONSTRAINT app_notification_delivery_chk
        CHECK (delivery IN ('inbox', 'popup'));

COMMENT ON COLUMN app_notification.delivery IS 'inbox — колокольчик; popup — колокольчик + модальное окно по центру';
