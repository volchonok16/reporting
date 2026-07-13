CREATE TABLE IF NOT EXISTS youjail_board_pin (
    id              BIGSERIAL PRIMARY KEY,
    employee_id     BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    board_id        BIGINT NOT NULL REFERENCES youjail_board(id) ON DELETE CASCADE,
    pinned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, board_id)
);

CREATE INDEX IF NOT EXISTS ix_youjail_board_pin_employee
    ON youjail_board_pin (employee_id, pinned_at ASC);

COMMENT ON TABLE youjail_board_pin IS 'Закреплённые доски YouJail (настройка пользователя)';
