-- Доска DocPlan во вкладке «Доска»: личное состояние и общие доски.
-- ./scripts/migrate.sh db/migrations/099_docplan_boards.sql

CREATE TABLE IF NOT EXISTS docplan_board (
    id          BIGSERIAL PRIMARY KEY,
    title       VARCHAR(190) NOT NULL,
    owner_id    BIGINT NOT NULL REFERENCES org_user (id) ON DELETE CASCADE,
    state       JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision    BIGINT NOT NULL DEFAULT 1,
    updated_by  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_docplan_board_owner ON docplan_board (owner_id);

CREATE TABLE IF NOT EXISTS docplan_board_member (
    board_id    BIGINT NOT NULL REFERENCES docplan_board (id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES org_user (id) ON DELETE CASCADE,
    role        VARCHAR(16) NOT NULL DEFAULT 'editor',
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_docplan_board_member_user ON docplan_board_member (user_id);

CREATE TABLE IF NOT EXISTS docplan_user_state (
    user_id     BIGINT PRIMARY KEY REFERENCES org_user (id) ON DELETE CASCADE,
    state       JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision    BIGINT NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS docplan_user_kv (
    user_id     BIGINT NOT NULL REFERENCES org_user (id) ON DELETE CASCADE,
    data_key    VARCHAR(64) NOT NULL,
    data_value  TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, data_key)
);

CREATE TABLE IF NOT EXISTS docplan_document (
    board_id    BIGINT NOT NULL REFERENCES docplan_board (id) ON DELETE CASCADE,
    doc_id      VARCHAR(64) NOT NULL,
    payload     JSONB NOT NULL,
    updated_by  BIGINT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (board_id, doc_id)
);

COMMENT ON TABLE docplan_board IS 'Общая доска DocPlan (вкладка «Доска»)';
COMMENT ON TABLE docplan_user_state IS 'Личная доска DocPlan пользователя reporting';
COMMENT ON TABLE docplan_document IS 'Документ доски DocPlan';

INSERT INTO app_page (page_key, label, sort_order, is_active)
VALUES ('docplan', 'Доска', 40, TRUE)
ON CONFLICT (page_key) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_active = TRUE,
    updated_at = NOW();
