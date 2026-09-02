-- Блокировка редактирования статуса продукта B2B по офисам (вкладкам)

ALTER TABLE b2b_product_status_office
    ADD COLUMN IF NOT EXISTS editing_locked BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN b2b_product_status_office.editing_locked IS
    'TRUE — сохранение и правки строк этого офиса запрещены для всех пользователей; снимает администратор';
