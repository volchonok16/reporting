-- YouJail: ответственный сотрудник на карточке
ALTER TABLE youjail_card
    ADD COLUMN IF NOT EXISTS assignee_employee_id BIGINT REFERENCES employee(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_youjail_card_assignee ON youjail_card (assignee_employee_id);
