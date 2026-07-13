-- Прямой доступ к доске YouJail: admin (колонки, участники) | member (карточки).
-- Применение: ./scripts/migrate.sh 023_youjail_board_member.sql

CREATE TABLE IF NOT EXISTS youjail_board_member (
    id              BIGSERIAL PRIMARY KEY,
    board_id        BIGINT NOT NULL REFERENCES youjail_board(id) ON DELETE CASCADE,
    employee_id     BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    role            VARCHAR(32) NOT NULL DEFAULT 'member',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (board_id, employee_id)
);

CREATE INDEX IF NOT EXISTS ix_youjail_board_member_board ON youjail_board_member (board_id);
CREATE INDEX IF NOT EXISTS ix_youjail_board_member_employee ON youjail_board_member (employee_id);

COMMENT ON TABLE youjail_board_member IS 'Прямой доступ к доске; role: admin | member';
COMMENT ON COLUMN youjail_board_member.role IS 'admin — управление колонками и участниками; member — карточки';
