-- Новости и запуски B2B: вкладки, строки, история, снимки версий

CREATE TABLE IF NOT EXISTS b2b_news_section (
    id              BIGSERIAL PRIMARY KEY,
    gid             VARCHAR(32)  NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE b2b_news_section IS 'Вкладки «Новости» и «Запуски»';
COMMENT ON COLUMN b2b_news_section.gid IS 'Стабильный ключ вкладки для API и UI';

CREATE TABLE IF NOT EXISTS b2b_news_row (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES b2b_news_section(id) ON DELETE CASCADE,
    sort_order      INT          NOT NULL DEFAULT 0,
    cells           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_news_row_section
    ON b2b_news_row (section_id, sort_order);

COMMENT ON TABLE b2b_news_row IS 'Строка таблицы новостей/запусков; cells — значения колонок с rich-text';
COMMENT ON COLUMN b2b_news_row.cells IS 'JSON: название колонки → текст ячейки';

CREATE TABLE IF NOT EXISTS b2b_news_history (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       REFERENCES b2b_news_row(id) ON DELETE SET NULL,
    section_id      BIGINT       NOT NULL REFERENCES b2b_news_section(id) ON DELETE CASCADE,
    section_name    VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    field_name      VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(255),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_news_history_section
    ON b2b_news_history (section_id, changed_at DESC);

COMMENT ON TABLE b2b_news_history IS 'История изменений новостей и запусков';
COMMENT ON COLUMN b2b_news_history.action IS 'create | update | delete | restore';

CREATE TABLE IF NOT EXISTS b2b_news_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES b2b_news_section(id) ON DELETE CASCADE,
    rows            JSONB        NOT NULL,
    changed_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_news_snapshot_section
    ON b2b_news_snapshot (section_id, created_at DESC, id DESC);

COMMENT ON TABLE b2b_news_snapshot IS 'Снимки строк вкладки после сохранения';
COMMENT ON COLUMN b2b_news_snapshot.rows IS 'JSON: {"rows": [{"cells": {...}}, ...]}';

INSERT INTO b2b_news_section (gid, name, sort_order) VALUES
    ('news', 'Новости', 10),
    ('launches', 'Запуски', 20)
ON CONFLICT (gid) DO NOTHING;
