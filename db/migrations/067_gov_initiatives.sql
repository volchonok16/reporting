-- Госинициативы: вкладка рядом с «Активности по выручкам»
-- Применить: ./scripts/migrate.sh db/migrations/067_gov_initiatives.sql

CREATE TABLE IF NOT EXISTS gov_initiative_section (
    id              BIGSERIAL PRIMARY KEY,
    gid             VARCHAR(32)  NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE gov_initiative_section IS 'Вкладки «Госинициативы»';
COMMENT ON COLUMN gov_initiative_section.gid IS 'Стабильный ключ вкладки для API и UI';

CREATE TABLE IF NOT EXISTS gov_initiative_row (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES gov_initiative_section(id) ON DELETE CASCADE,
    sort_order      INT          NOT NULL DEFAULT 0,
    cells           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_initiative_row_section
    ON gov_initiative_row (section_id, sort_order);

COMMENT ON TABLE gov_initiative_row IS 'Строка таблицы госинициатив; cells — Закон / Описание / Номер ЗнИ / Статус';
COMMENT ON COLUMN gov_initiative_row.cells IS 'JSON: Закон, Описание, Номер ЗнИ, Статус → текст ячейки';

CREATE TABLE IF NOT EXISTS gov_initiative_history (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       REFERENCES gov_initiative_row(id) ON DELETE SET NULL,
    section_id      BIGINT       NOT NULL REFERENCES gov_initiative_section(id) ON DELETE CASCADE,
    section_name    VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    field_name      VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(255),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_initiative_history_section
    ON gov_initiative_history (section_id, changed_at DESC);

COMMENT ON TABLE gov_initiative_history IS 'История изменений госинициатив';
COMMENT ON COLUMN gov_initiative_history.action IS 'create | update | delete | restore';

CREATE TABLE IF NOT EXISTS gov_initiative_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    section_id      BIGINT       NOT NULL REFERENCES gov_initiative_section(id) ON DELETE CASCADE,
    rows            JSONB        NOT NULL,
    changed_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gov_initiative_snapshot_section
    ON gov_initiative_snapshot (section_id, created_at DESC, id DESC);

COMMENT ON TABLE gov_initiative_snapshot IS 'Снимки строк вкладки после сохранения';
COMMENT ON COLUMN gov_initiative_snapshot.rows IS 'JSON: {"rows": [{"cells": {...}}, ...]}';

INSERT INTO gov_initiative_section (gid, name, sort_order) VALUES
    ('main', 'Госинициативы', 10)
ON CONFLICT (gid) DO NOTHING;
