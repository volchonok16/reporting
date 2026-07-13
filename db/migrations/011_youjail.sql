CREATE TABLE IF NOT EXISTS youjail_project (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(64) NOT NULL UNIQUE,
    repo_path       TEXT,
    context_md      TEXT NOT NULL DEFAULT '',
    instructions_md TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youjail_task_type (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(128) NOT NULL UNIQUE,
    instructions_md TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youjail_column (
    id              BIGSERIAL PRIMARY KEY,
    column_key      VARCHAR(32) NOT NULL UNIQUE,
    title           VARCHAR(128) NOT NULL,
    tone            VARCHAR(32) NOT NULL,
    sort_order      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS youjail_card (
    id              BIGSERIAL PRIMARY KEY,
    column_id       BIGINT NOT NULL REFERENCES youjail_column(id) ON DELETE RESTRICT,
    project_id      BIGINT REFERENCES youjail_project(id) ON DELETE SET NULL,
    task_type_id    BIGINT REFERENCES youjail_task_type(id) ON DELETE SET NULL,
    title           VARCHAR(1000) NOT NULL,
    description_md  TEXT NOT NULL DEFAULT '',
    pinned          BOOLEAN NOT NULL DEFAULT FALSE,
    archived        BOOLEAN NOT NULL DEFAULT FALSE,
    closed_at       TIMESTAMPTZ,
    scheduled_at    TIMESTAMPTZ,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    executor        VARCHAR(64) NOT NULL DEFAULT 'manual',
    worktree_path   TEXT,
    worktree_branch VARCHAR(255),
    execution_status VARCHAR(32) NOT NULL DEFAULT 'idle',
    created_by      VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_youjail_card_column_sort
    ON youjail_card (column_id, sort_order, id);

CREATE INDEX IF NOT EXISTS ix_youjail_card_search
    ON youjail_card USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description_md, '')));

CREATE TABLE IF NOT EXISTS youjail_attachment (
    id              BIGSERIAL PRIMARY KEY,
    card_id         BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    filename        VARCHAR(512) NOT NULL,
    storage_path    TEXT NOT NULL,
    content_type    VARCHAR(128),
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youjail_execution (
    id              BIGSERIAL PRIMARY KEY,
    card_id         BIGINT NOT NULL REFERENCES youjail_card(id) ON DELETE CASCADE,
    executor        VARCHAR(64) NOT NULL,
    status          VARCHAR(32) NOT NULL DEFAULT 'running',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    exit_code       INTEGER,
    error_message   TEXT,
    worktree_path   TEXT
);

CREATE INDEX IF NOT EXISTS ix_youjail_execution_card_started
    ON youjail_execution (card_id, started_at DESC);

CREATE TABLE IF NOT EXISTS youjail_execution_log (
    id              BIGSERIAL PRIMARY KEY,
    execution_id    BIGINT NOT NULL REFERENCES youjail_execution(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    stream          VARCHAR(16) NOT NULL DEFAULT 'stdout',
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (execution_id, seq)
);

-- Seed колонок перенесён в 017_youjail_boards_fuzzy.sql (board_id + уникальность по доске).

INSERT INTO youjail_task_type (name, instructions_md, sort_order)
VALUES
    ('feature', 'Реализовать новую функциональность.', 1),
    ('bugfix', 'Исправить ошибку и добавить регрессионную проверку.', 2),
    ('chore', 'Техническое обслуживание без изменения поведения.', 3)
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE youjail_card IS 'Карточки доски YouJail (отдельно от task/reporting)';
COMMENT ON TABLE youjail_execution IS 'Запуски исполнителя по карточке YouJail';
