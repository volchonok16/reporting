-- Активности по выручкам: вкладка, строки, история, снимки версий

CREATE TABLE IF NOT EXISTS revenue_activity_section (
    id              BIGSERIAL PRIMARY KEY,
    gid             VARCHAR(32)  NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE revenue_activity_section IS 'Вкладки «Активности по выручкам»';
COMMENT ON COLUMN revenue_activity_section.gid IS 'Стабильный ключ вкладки для API и UI';

CREATE TABLE IF NOT EXISTS revenue_activity_row (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES revenue_activity_section(id) ON DELETE CASCADE,
    sort_order      INT          NOT NULL DEFAULT 0,
    cells           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_activity_row_section
    ON revenue_activity_row (section_id, sort_order);

COMMENT ON TABLE revenue_activity_row IS 'Строка таблицы активностей по выручкам; cells — значения колонок с rich-text';
COMMENT ON COLUMN revenue_activity_row.cells IS 'JSON: Статус / Ответственный / Результат → текст ячейки';

CREATE TABLE IF NOT EXISTS revenue_activity_history (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       REFERENCES revenue_activity_row(id) ON DELETE SET NULL,
    section_id      BIGINT       NOT NULL REFERENCES revenue_activity_section(id) ON DELETE CASCADE,
    section_name    VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    field_name      VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(255),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_activity_history_section
    ON revenue_activity_history (section_id, changed_at DESC);

COMMENT ON TABLE revenue_activity_history IS 'История изменений активностей по выручкам';
COMMENT ON COLUMN revenue_activity_history.action IS 'create | update | delete | restore';

CREATE TABLE IF NOT EXISTS revenue_activity_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES revenue_activity_section(id) ON DELETE CASCADE,
    rows            JSONB        NOT NULL,
    changed_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_revenue_activity_snapshot_section
    ON revenue_activity_snapshot (section_id, created_at DESC, id DESC);

COMMENT ON TABLE revenue_activity_snapshot IS 'Снимки строк вкладки после сохранения';
COMMENT ON COLUMN revenue_activity_snapshot.rows IS 'JSON: {"rows": [{"cells": {...}}, ...]}';

INSERT INTO revenue_activity_section (gid, name, sort_order) VALUES
    ('main', 'Активности по выручкам', 10)
ON CONFLICT (gid) DO NOTHING;
