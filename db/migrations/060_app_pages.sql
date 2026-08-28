-- Справочник страниц приложения и доступ «других пользователей»
-- ./scripts/migrate.sh db/migrations/060_app_pages.sql

CREATE TABLE IF NOT EXISTS app_page (
    page_key    VARCHAR(64)  PRIMARY KEY,
    label       VARCHAR(255) NOT NULL,
    sort_order  INT          NOT NULL DEFAULT 0,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app_page IS 'Справочник вкладок reporting (ключ = SheetId во frontend)';
COMMENT ON COLUMN app_page.page_key IS 'Стабильный ключ страницы, например zni, departments, voice';

CREATE TABLE IF NOT EXISTS org_user_page_access (
    org_user_id BIGINT      NOT NULL REFERENCES org_user(id) ON DELETE CASCADE,
    page_key    VARCHAR(64) NOT NULL REFERENCES app_page(page_key) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_user_id, page_key)
);

COMMENT ON TABLE org_user_page_access IS 'Разрешённые вкладки для учётной записи с флагом «Другие пользователи» (employee.hide_from_pyramid)';

CREATE INDEX IF NOT EXISTS org_user_page_access_user_idx ON org_user_page_access (org_user_id);
