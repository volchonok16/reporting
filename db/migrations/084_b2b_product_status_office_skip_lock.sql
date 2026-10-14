-- До этого момента автоблокировка офиса не срабатывает. Пусто — расписание работает как обычно.

ALTER TABLE b2b_product_status_office
    ADD COLUMN IF NOT EXISTS skip_lock_until TIMESTAMPTZ;

COMMENT ON COLUMN b2b_product_status_office.skip_lock_until IS
    'До этого момента Europe/Moscow офис не блокируется по расписанию. Задаёт суперадминистратор';
