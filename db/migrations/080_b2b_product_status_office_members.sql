-- Автоблокировка по офисам и сотрудники, закреплённые за офисом.
-- Общий выключатель b2b_product_status_settings больше не используется.

ALTER TABLE b2b_product_status_office
    ADD COLUMN IF NOT EXISTS auto_lock_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN b2b_product_status_office.auto_lock_enabled IS
    'true — четверг 09:30 МСК блокирует этот офис и шлёт письмо его сотрудникам, 18:00 снимает блокировку. false — расписание этот офис не трогает';

CREATE TABLE IF NOT EXISTS b2b_product_status_office_member (
    office_id   BIGINT NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (office_id, employee_id)
);

COMMENT ON TABLE b2b_product_status_office_member IS
    'Сотрудники, закреплённые за офисом статуса продукта: им уходит письмо, когда офис блокируют или разблокируют';

DROP TABLE IF EXISTS b2b_product_status_settings;
