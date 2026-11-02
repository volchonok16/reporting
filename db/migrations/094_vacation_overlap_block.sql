-- Запрет пересечения отпусков: пары сотрудников, которым нельзя отдыхать в одни дни.
-- ./scripts/migrate.sh db/migrations/094_vacation_overlap_block.sql

CREATE TABLE IF NOT EXISTS vacation_overlap_block (
    employee_id_a   BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    employee_id_b   BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by_org_user_id BIGINT REFERENCES org_user(id) ON DELETE SET NULL,
    PRIMARY KEY (employee_id_a, employee_id_b),
    CONSTRAINT vacation_overlap_block_ordered CHECK (employee_id_a < employee_id_b)
);

CREATE INDEX IF NOT EXISTS idx_vacation_overlap_block_b
    ON vacation_overlap_block (employee_id_b);

COMMENT ON TABLE vacation_overlap_block IS
  'Пары сотрудников (a < b), которым запрещено пересечение дней отпуска';
COMMENT ON COLUMN vacation_overlap_block.employee_id_a IS 'Меньший employee.id пары';
COMMENT ON COLUMN vacation_overlap_block.employee_id_b IS 'Больший employee.id пары';
