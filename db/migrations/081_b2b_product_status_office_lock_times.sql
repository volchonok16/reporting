-- Время последней блокировки и разблокировки по каждому офису статуса.

ALTER TABLE b2b_product_status_office
    ADD COLUMN IF NOT EXISTS editing_locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS editing_unlocked_at TIMESTAMPTZ;

COMMENT ON COLUMN b2b_product_status_office.editing_locked_at IS
    'Момент, когда этот офис последний раз заблокировали (расписание или вручную)';
COMMENT ON COLUMN b2b_product_status_office.editing_unlocked_at IS
    'Момент, когда этот офис последний раз разблокировали';
