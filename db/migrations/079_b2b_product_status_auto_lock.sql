-- Выключатель автоматической блокировки статуса продукта.
-- Расписание напоминания не зависит от этого флага.

CREATE TABLE IF NOT EXISTS b2b_product_status_settings (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    auto_lock_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE b2b_product_status_settings IS
    'Одна строка: включена ли автоматическая блокировка офисов статуса продукта';
COMMENT ON COLUMN b2b_product_status_settings.auto_lock_enabled IS
    'true — четверг 09:30 МСК блокирует офисы и шлёт письмо, 18:00 снимает блокировку. false — эти два шага пропускаются, напоминание в среду остаётся';

INSERT INTO b2b_product_status_settings (id, auto_lock_enabled)
VALUES (1, TRUE)
ON CONFLICT (id) DO NOTHING;
