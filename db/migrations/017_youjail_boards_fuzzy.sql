CREATE TABLE IF NOT EXISTS youjail_board (
    id              BIGSERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(64) NOT NULL UNIQUE,
    description     TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO youjail_board (id, name, slug, sort_order)
VALUES (1, 'Основная', 'main', 1)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE youjail_column ADD COLUMN IF NOT EXISTS board_id BIGINT;
UPDATE youjail_column SET board_id = 1 WHERE board_id IS NULL;
ALTER TABLE youjail_column ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE youjail_column DROP CONSTRAINT IF EXISTS youjail_column_board_id_fkey;
ALTER TABLE youjail_column
    ADD CONSTRAINT youjail_column_board_id_fkey
    FOREIGN KEY (board_id) REFERENCES youjail_board(id) ON DELETE CASCADE;

ALTER TABLE youjail_column DROP CONSTRAINT IF EXISTS youjail_column_column_key_key;
DROP INDEX IF EXISTS youjail_column_column_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS ix_youjail_column_board_key
    ON youjail_column (board_id, column_key);

INSERT INTO youjail_column (board_id, column_key, title, tone, sort_order)
VALUES
    (1, 'backlog', 'Backlog', 'backlog', 1),
    (1, 'in_progress', 'In Progress', 'progress', 2),
    (1, 'blocked', 'Blocked', 'blocked', 3),
    (1, 'done', 'Done', 'done', 4)
ON CONFLICT (board_id, column_key) DO NOTHING;

ALTER TABLE youjail_card ADD COLUMN IF NOT EXISTS board_id BIGINT;
UPDATE youjail_card SET board_id = 1 WHERE board_id IS NULL;
ALTER TABLE youjail_card ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE youjail_card DROP CONSTRAINT IF EXISTS youjail_card_board_id_fkey;
ALTER TABLE youjail_card
    ADD CONSTRAINT youjail_card_board_id_fkey
    FOREIGN KEY (board_id) REFERENCES youjail_board(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_youjail_card_board_column
    ON youjail_card (board_id, column_id, sort_order, id);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS ix_youjail_card_title_trgm
    ON youjail_card USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ix_youjail_card_description_trgm
    ON youjail_card USING gin (description_md gin_trgm_ops);

COMMENT ON TABLE youjail_board IS 'Kanban-доски YouJail (несколько досок на вкладке «Доска»)';
