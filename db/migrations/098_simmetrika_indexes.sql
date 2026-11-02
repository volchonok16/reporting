-- Индексы и права для хранилища Симметрики (после 097).
-- ./scripts/migrate.sh db/migrations/098_simmetrika_indexes.sql

CREATE UNIQUE INDEX IF NOT EXISTS ux_simmetrika_users_email
    ON simmetrika_kv (lower(payload->>'email'))
    WHERE bucket = 'users' AND payload->>'email' IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_simmetrika_sessions_user
    ON simmetrika_kv ((payload->>'userId'))
    WHERE bucket = 'sessions';

COMMENT ON INDEX ux_simmetrika_users_email IS 'Симметрика: уникальный email пользователя (SSO без дублей)';
COMMENT ON INDEX ix_simmetrika_sessions_user IS 'Симметрика: сессии по userId (logout / delete account)';

GRANT ALL PRIVILEGES ON TABLE simmetrika_kv TO alex, ivan;
GRANT ALL PRIVILEGES ON TABLE simmetrika_blob TO alex, ivan;
GRANT ALL PRIVILEGES ON TABLE simmetrika_secret TO alex, ivan;
