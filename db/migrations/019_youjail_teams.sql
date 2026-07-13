-- YouJail: команды и доступ к доскам
CREATE TABLE IF NOT EXISTS youjail_team (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(64) NOT NULL UNIQUE,
    description     TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youjail_team_member (
    id              BIGSERIAL PRIMARY KEY,
    team_id         BIGINT NOT NULL REFERENCES youjail_team(id) ON DELETE CASCADE,
    employee_id     BIGINT NOT NULL REFERENCES employee(id) ON DELETE CASCADE,
    role            VARCHAR(32) NOT NULL DEFAULT 'member',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, employee_id)
);

CREATE TABLE IF NOT EXISTS youjail_board_team (
    id              BIGSERIAL PRIMARY KEY,
    board_id        BIGINT NOT NULL REFERENCES youjail_board(id) ON DELETE CASCADE,
    team_id         BIGINT NOT NULL REFERENCES youjail_team(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (board_id, team_id)
);

CREATE INDEX IF NOT EXISTS ix_youjail_team_member_employee ON youjail_team_member (employee_id);
CREATE INDEX IF NOT EXISTS ix_youjail_board_team_board ON youjail_board_team (board_id);
CREATE INDEX IF NOT EXISTS ix_youjail_board_team_team ON youjail_board_team (team_id);

INSERT INTO youjail_team (name, slug, description, sort_order)
VALUES ('Основная команда', 'main-team', 'Команда по умолчанию для доски «Основная»', 1)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO youjail_board_team (board_id, team_id)
SELECT 1, id FROM youjail_team WHERE slug = 'main-team'
ON CONFLICT (board_id, team_id) DO NOTHING;
