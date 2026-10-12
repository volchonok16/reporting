-- Вложения строк статуса продукта B2B (файлы в MinIO / локальный fallback).

CREATE TABLE IF NOT EXISTS b2b_product_status_attachment (
    id              BIGSERIAL PRIMARY KEY,
    row_id          BIGINT       NOT NULL REFERENCES b2b_product_status_row(id) ON DELETE CASCADE,
    filename        VARCHAR(512) NOT NULL,
    storage_key     TEXT         NOT NULL,
    content_type    VARCHAR(128),
    size_bytes      BIGINT       NOT NULL DEFAULT 0,
    uploaded_by     VARCHAR(255),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_b2b_product_status_attachment_row
    ON b2b_product_status_attachment (row_id, id);

COMMENT ON TABLE b2b_product_status_attachment IS
    'Файлы, прикреплённые к строке статуса продукта B2B; бинарные данные в MinIO (storage_key)';
COMMENT ON COLUMN b2b_product_status_attachment.storage_key IS
    'Ключ объекта MinIO (bucket product-status) или относительный путь локального fallback';
COMMENT ON COLUMN b2b_product_status_attachment.filename IS
    'Оригинальное имя файла для отображения и скачивания';
