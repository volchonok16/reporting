-- Снимки версий таблицы «Статус продукта B2B» для отката к сохранённому состоянию

CREATE TABLE IF NOT EXISTS b2b_product_status_snapshot (
    id              BIGSERIAL PRIMARY KEY,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    rows            JSONB        NOT NULL,
    changed_by      VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_product_status_snapshot_office
    ON b2b_product_status_snapshot (office_id, created_at DESC, id DESC);

COMMENT ON TABLE b2b_product_status_snapshot IS 'Снимки строк офиса после сохранения; используются для отката к версии';
COMMENT ON COLUMN b2b_product_status_snapshot.rows IS 'JSON: {"rows": [{"cells": {...}}, ...]} — полный порядок строк офиса';
