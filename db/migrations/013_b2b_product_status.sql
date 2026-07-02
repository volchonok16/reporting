-- Статус продукта B2B: офисы (вкладки), строки таблицы, история изменений

CREATE TABLE IF NOT EXISTS b2b_product_status_office (
    id              BIGSERIAL PRIMARY KEY,
    gid             VARCHAR(32)  NOT NULL UNIQUE,
    name            VARCHAR(255) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE b2b_product_status_office IS 'Продуктовые офисы B2B (вкладки «Офис: SMS», «Офис: CORE» и т.д.)';
COMMENT ON COLUMN b2b_product_status_office.gid IS 'Идентификатор вкладки (стабильный ключ для API и UI)';

CREATE TABLE IF NOT EXISTS b2b_product_status_row (
    id              BIGSERIAL PRIMARY KEY,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    sort_order      INT          NOT NULL DEFAULT 0,
    cells           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_product_status_row_office
    ON b2b_product_status_row (office_id, sort_order);

COMMENT ON TABLE b2b_product_status_row IS 'Строка таблицы статуса продукта B2B; cells — значения колонок с rich-text разметкой';
COMMENT ON COLUMN b2b_product_status_row.cells IS 'JSON: название колонки → текст ячейки (формат product_status_rich_text)';

CREATE TABLE IF NOT EXISTS b2b_product_status_history (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       REFERENCES b2b_product_status_row(id) ON DELETE SET NULL,
    office_id       BIGINT       NOT NULL REFERENCES b2b_product_status_office(id) ON DELETE CASCADE,
    office_name     VARCHAR(255) NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    field_name      VARCHAR(255),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(255),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_product_status_history_office
    ON b2b_product_status_history (office_id, changed_at DESC);

COMMENT ON TABLE b2b_product_status_history IS 'История изменений строк статуса продукта B2B';
COMMENT ON COLUMN b2b_product_status_history.action IS 'create | update | delete';

INSERT INTO b2b_product_status_office (gid, name, sort_order) VALUES
    ('1512199647', 'Офис: SMS', 10),
    ('1699821818', 'Офис: VOICE', 20),
    ('1909385714', 'Офис: Перспективные продукты', 30),
    ('102191664', 'Офис: M2M / IoT', 40),
    ('128901598', 'Офис: Продуктовый маркетинг', 50),
    ('0', 'Офис: CORE', 60),
    ('core_ops', 'Офис: CORE (операционка)', 70)
ON CONFLICT (gid) DO NOTHING;
