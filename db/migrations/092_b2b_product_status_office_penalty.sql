-- Баллы офиса («косяк»): +1 при разблокировке обычным администратором,
-- плюс и минус задаёт суперадминистратор.

ALTER TABLE b2b_product_status_office
    ADD COLUMN IF NOT EXISTS penalty_points INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN b2b_product_status_office.penalty_points IS
    'Баллы офиса. +1, когда офис разблокирует администратор (org_user.role = 100). Суперадминистратор начисляет и списывает вручную. Ниже нуля не опускается';
