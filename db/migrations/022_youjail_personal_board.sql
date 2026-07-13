-- Личные доски YouJail: одна доска на сотрудника, название = ФИО.
-- Применение: ./scripts/migrate.sh 022_youjail_personal_board.sql

ALTER TABLE youjail_board
  ADD COLUMN IF NOT EXISTS owner_employee_id BIGINT REFERENCES employee(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS ix_youjail_board_personal_owner
  ON youjail_board (owner_employee_id)
  WHERE owner_employee_id IS NOT NULL;

COMMENT ON COLUMN youjail_board.owner_employee_id IS 'Личная доска сотрудника; NULL = общая/командная доска';
