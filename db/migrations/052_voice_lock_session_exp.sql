-- Срок bearer-сессии владельца блокировки мастер-файла (без voice_auth_sessions).
-- ./scripts/migrate.sh db/migrations/052_voice_lock_session_exp.sql

ALTER TABLE master_edit_lock
    ADD COLUMN IF NOT EXISTS owner_session_expires_at DOUBLE PRECISION;

COMMENT ON COLUMN master_edit_lock.owner_session_expires_at IS
    'Unix time истечения bearer-сессии Voice владельца (SSO reporting)';
