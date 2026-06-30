-- Справочник мест и бронь по календарным дням.
-- Применение: ./scripts/migrate.sh 008_workspace_booking.sql

CREATE TABLE IF NOT EXISTS workspace_place (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_booking (
    id              BIGSERIAL PRIMARY KEY,
    place_id        BIGINT       NOT NULL REFERENCES workspace_place(id) ON DELETE CASCADE,
    employee_id     BIGINT       NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    day             DATE         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (place_id, day),
    UNIQUE (employee_id, day)
);

CREATE INDEX IF NOT EXISTS idx_workspace_booking_day ON workspace_booking (day);
CREATE INDEX IF NOT EXISTS idx_workspace_booking_place_day ON workspace_booking (place_id, day);

COMMENT ON TABLE workspace_place IS 'Справочник рабочих мест (бронь)';
COMMENT ON TABLE workspace_booking IS 'Бронь места на календарный день; одно место — один сотрудник в день';

INSERT INTO workspace_place (name, sort_order)
SELECT 'Место ' || n, n
FROM generate_series(23, 53) AS n
WHERE NOT EXISTS (SELECT 1 FROM workspace_place LIMIT 1);
