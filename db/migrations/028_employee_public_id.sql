-- Публичный UUID сотрудника для ссылок и упоминаний (вместо числового id в UI).
ALTER TABLE employee
    ADD COLUMN IF NOT EXISTS public_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS employee_public_id_uq ON employee (public_id);
